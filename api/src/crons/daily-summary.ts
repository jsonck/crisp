import { Env } from "../index";
import {
  WEBSITE_ID,
  fetchAllMessages,
  listConversations,
  type CrispConversation,
  type CrispMessage,
} from "../crisp";
import { replaceModelTags, saveDailySummary, syncConversation, type ModelTag } from "../log";

type Message = CrispMessage;
type Conversation = CrispConversation & { updated_at: number; state: string };

interface AnalysisResult {
  conversations: ConversationSummary[];
  escalated: ConversationSummary[];
  went_well: ConversationSummary[];
  topics: TopicCategory[];
  // One row per conversation: which bucket the model put it in. The counts in
  // `topics` are derived from this rather than asked for, because a model
  // adding up its own categories is a step that can silently be wrong, and
  // because a count is useless for tagging — a tag needs a session_id.
  classified: Classification[];
  total_count: number;
}

interface Classification {
  session_id: string;
  topic: string;
  subtopic: string;
}

interface ConversationSummary {
  nickname: string;
  email: string;
  session_id: string;
  reason: string;
}

interface TopicCategory {
  name: string;
  count: number;
  subtopics: { name: string; count: number }[];
}

export async function dailySummary(env: Env) {
  const yesterday = getYesterdayRange();
  const conversations = await fetchYesterdayConversations(env, yesterday);

  if (conversations.length === 0) {
    const emailedEmpty = await sendEmail(env, formatEmptyDay(yesterday.dateStr));
    // Still recorded. A day with no conversations is a real data point, and a
    // gap in the table would be indistinguishable from a night the cron failed.
    await saveDailySummary(env, yesterday.isoDate, 0, { empty: true }, emailedEmpty);
    return;
  }

  // Fetch messages for each conversation
  const conversationsWithMessages = await Promise.all(
    conversations.map(async (conv) => ({
      ...conv,
      messages: (await fetchAllMessages(env, conv.session_id)) ?? [],
    }))
  );

  // This is the only place that holds a full transcript for every conversation
  // of a day, so it is where the mirror gets its complete rows: `complete`,
  // the real started_at, and the operator replies a webhook never sees because
  // nobody wrote to the bot again afterwards.
  //
  // Sequential on purpose. Twenty parallel conversation syncs is a burst of a
  // hundred-odd PostgREST calls, and nothing here is in a hurry at 10am UTC.
  let mirrored = 0;
  for (const conv of conversationsWithMessages) {
    try {
      await syncConversation(env, conv.session_id, conv.messages, {
        websiteId: WEBSITE_ID,
        apiKey: typeof conv.meta?.data?.api_key === "string" ? conv.meta.data.api_key : null,
        nickname: conv.meta?.nickname ?? null,
        email: conv.meta?.email ?? null,
        state: conv.state ?? null,
        complete: true,
      });
      mirrored++;
    } catch (e) {
      console.error("Nightly mirror failed for", conv.session_id, e);
    }
  }
  console.log(`Mirrored ${mirrored}/${conversationsWithMessages.length} conversations`);

  // Analyze with Claude
  const analysis = await analyzeWithClaude(env, conversationsWithMessages);

  // Format and send
  const html = formatSummaryEmail(yesterday.dateStr, analysis);
  const emailed = await sendEmail(env, html);

  // Keep the analysis. It used to exist only inside that email, which meant no
  // two days could ever be compared — the single biggest reason this bot had
  // no sense of a trend.
  await saveDailySummary(env, yesterday.isoDate, analysis.total_count, analysis, emailed);
  await persistTags(env, conversationsWithMessages.map((c) => c.session_id), analysis);
}

// The analysis, re-expressed as tags on conversations. Topic and subtopic are
// separate tags rather than one "Topic / Subtopic" string, so that counting a
// parent category stays a plain equality and does not become a prefix match.
async function persistTags(
  env: Env,
  sessionIds: string[],
  analysis: AnalysisResult
) {
  const tags: ModelTag[] = [];

  for (const c of analysis.classified ?? []) {
    if (!c?.session_id) continue;
    if (c.topic) tags.push({ sessionId: c.session_id, tag: c.topic });
    if (c.subtopic && c.subtopic !== c.topic) {
      tags.push({ sessionId: c.session_id, tag: c.subtopic });
    }
  }

  // The two judgement calls are worth tagging in their own right: "show me
  // every escalation this month" is the query this whole table exists for, and
  // the model's reason travels with it.
  for (const e of analysis.escalated ?? []) {
    if (e?.session_id) tags.push({ sessionId: e.session_id, tag: "escalated", note: e.reason });
  }
  for (const w of analysis.went_well ?? []) {
    if (w?.session_id) tags.push({ sessionId: w.session_id, tag: "went-well", note: w.reason });
  }

  // Scoped to the conversations actually analysed, so a re-run for one day
  // clears that day's model tags and nothing else. Hallucinated session_ids
  // are dropped here rather than failing the insert on a foreign key.
  const known = new Set(sessionIds);
  const dropped = tags.filter((t) => !known.has(t.sessionId));
  if (dropped.length) {
    console.error(`Discarding ${dropped.length} tags for unknown sessions`);
  }

  await replaceModelTags(env, sessionIds, tags.filter((t) => known.has(t.sessionId)));
}

function getYesterdayRange() {
  const now = new Date();
  // Convert to New York time
  const ny = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  ny.setDate(ny.getDate() - 1);
  ny.setHours(0, 0, 0, 0);
  const startOfDay = ny.getTime();
  ny.setHours(23, 59, 59, 999);
  const endOfDay = ny.getTime();

  const dateStr = ny.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

  // Same instant and same timezone as dateStr, so the row the summary is
  // stored under can never disagree with the date printed in the email.
  const isoDate = ny.toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });

  return { startOfDay, endOfDay, dateStr, isoDate };
}

async function fetchYesterdayConversations(
  env: Env,
  yesterday: { startOfDay: number; endOfDay: number }
): Promise<Conversation[]> {
  const all: Conversation[] = [];

  for (let page = 1; page <= 50; page++) {
    const data = await listConversations(env, page);
    if (!data || data.length === 0) break;

    for (const conv of data) {
      const updatedAt = conv.updated_at ?? 0;
      if (updatedAt >= yesterday.startOfDay && updatedAt <= yesterday.endOfDay) {
        all.push(conv as Conversation);
      } else if (updatedAt < yesterday.startOfDay) {
        // The list is sorted by updated_at desc, so everything after this is
        // older than the window.
        return all;
      }
    }
  }

  return all;
}

async function analyzeWithClaude(
  env: Env,
  conversations: (Conversation & { messages: Message[] })[]
): Promise<AnalysisResult> {
  const transcripts = conversations.map((conv) => {
    const msgs = conv.messages
      .filter((m) => m.type === "text" || m.type === "note")
      .map((m) => {
        const time = new Date(m.timestamp).toLocaleString();
        if (m.type === "note") {
          return `[${time}] [Note by ${m.user?.nickname || "Agent"}]: ${m.content}`;
        }
        return `[${time}] ${m.from === "user" ? "Customer" : "Agent"}: ${m.content}`;
      })
      .join("\n");

    return `--- Conversation with ${conv.meta?.nickname || "Unknown"} (${conv.meta?.email || "no email"}) [session_id: ${conv.session_id}] ---\n${msgs}`;
  });

  const prompt = `You are analyzing a day's worth of customer service conversations for a Shopify app called Pop Convert. There were ${conversations.length} conversations yesterday.

Here are all the conversations:

${transcripts.join("\n\n")}

Analyze these conversations and respond with valid JSON only (no markdown fences). Use this exact structure:

{
  "escalated": [
    { "session_id": "<session_id from the transcript>", "reason": "<brief reason why this was escalated or problematic>" }
  ],
  "went_well": [
    { "session_id": "<session_id from the transcript>", "reason": "<brief reason why this went well>" }
  ],
  "classified": [
    { "session_id": "<session_id from the transcript>", "topic": "<Parent Category>", "subtopic": "<specific subtopic>" }
  ],
  "total_count": ${conversations.length}
}

Rules:
- Identify every conversation by its session_id only. Names and emails are already known here and copying them back wastes output and invents typos.
- "escalated": conversations where the customer was frustrated/angry, the issue wasn't resolved, the agent struggled, or the customer threatened to leave/asked for a refund. Be selective — only flag truly problematic ones.
- "went_well": conversations where the customer expressed gratitude, the issue was resolved quickly, or the agent went above and beyond. Be selective — only flag genuinely positive ones.
- "classified": one entry for EVERY conversation, with no conversation left out and none listed twice. Group them into a small set of parent categories, each broken into a specific subtopic. Reuse the same category and subtopic wording across conversations — these become tags, and "Billing" and "billing questions" as two separate tags make a month of data uncountable.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      // 4096 was not enough: a day of 44 conversations truncated the JSON
      // mid-string and the whole analysis was lost to a parse error (the
      // fallback is empty arrays, so the email silently lost its topics).
      // The response is one line per conversation plus two short lists, so it
      // scales with the day; 16k leaves room for a busy one.
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Anthropic error:", errText);
    return { conversations: [], escalated: [], went_well: [], topics: [], classified: [], total_count: conversations.length };
  }

  const json = (await response.json()) as { content: { text: string }[]; stop_reason?: string };
  const text = json.content?.[0]?.text;
  const stopReason = json.stop_reason;

  if (stopReason === "max_tokens") {
    console.error("Claude response truncated (max_tokens). Response length:", text?.length);
  }

  try {
    const parsed = JSON.parse(text) as AnalysisResult;

    // The model is given session_ids and returns them; the names come from
    // Crisp, where they are already correct. A session_id it invented resolves
    // to nothing and is dropped rather than printed as "undefined".
    const names = new Map(
      conversations.map((c) => [
        c.session_id,
        { nickname: c.meta?.nickname || "Unknown", email: c.meta?.email || "no email" },
      ])
    );
    const name = (rows: ConversationSummary[] = []) =>
      rows
        .filter((r) => r?.session_id && names.has(r.session_id))
        .map((r) => ({ ...r, ...names.get(r.session_id)! }));

    return {
      ...parsed,
      escalated: name(parsed.escalated),
      went_well: name(parsed.went_well),
      topics: rollUp(parsed.classified ?? []),
    };
  } catch {
    console.error("Failed to parse Claude response. stop_reason:", stopReason, "text:", text?.substring(0, 500));
    return { conversations: [], escalated: [], went_well: [], topics: [], classified: [], total_count: conversations.length };
  }
}

// Counts, computed rather than asked for. The email reads exactly as it did
// when the model supplied these numbers; the difference is that they now add
// up, and that each one can be clicked through to the conversations behind it
// via conversation_tags.
function rollUp(classified: Classification[]): TopicCategory[] {
  const parents = new Map<string, Map<string, number>>();

  for (const c of classified) {
    if (!c?.topic) continue;
    const subs = parents.get(c.topic) ?? new Map<string, number>();
    const sub = c.subtopic || "Other";
    subs.set(sub, (subs.get(sub) ?? 0) + 1);
    parents.set(c.topic, subs);
  }

  return [...parents.entries()]
    .map(([name, subs]) => ({
      name,
      count: [...subs.values()].reduce((a, b) => a + b, 0),
      subtopics: [...subs.entries()]
        .map(([subName, count]) => ({ name: subName, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);
}

function formatSummaryEmail(dateStr: string, analysis: AnalysisResult): string {
  const crispLink = (sessionId: string) =>
    `https://app.crisp.chat/website/${WEBSITE_ID}/inbox/${sessionId}/`;

  const escalatedHtml = analysis.escalated.length
    ? analysis.escalated
        .map(
          (e) =>
            `<li><strong>${e.nickname}</strong> (${e.email}) — ${e.reason} <a href="${crispLink(e.session_id)}">View →</a></li>`
        )
        .join("")
    : "<li>None — all good!</li>";

  const wentWellHtml = analysis.went_well.length
    ? analysis.went_well
        .map(
          (w) =>
            `<li><strong>${w.nickname}</strong> (${w.email}) — ${w.reason} <a href="${crispLink(w.session_id)}">View →</a></li>`
        )
        .join("")
    : "<li>None flagged</li>";

  const topicsHtml = analysis.topics
    .map((t) => {
      const subtopics = t.subtopics
        .map((s) => `<li>${s.name}: ${s.count}</li>`)
        .join("");
      return `<li><strong>${t.name}</strong> (${t.count})<ul>${subtopics}</ul></li>`;
    })
    .join("");

  return `
    <h1>Daily Crisp Summary — ${dateStr}</h1>
    <p><strong>${analysis.total_count} conversations</strong> total</p>

    <h2>🔴 Escalated (${analysis.escalated.length})</h2>
    <ul>${escalatedHtml}</ul>

    <h2>🟢 Went Well (${analysis.went_well.length})</h2>
    <ul>${wentWellHtml}</ul>

    <h2>📂 Topics</h2>
    <ul>${topicsHtml}</ul>
  `;
}

function formatEmptyDay(dateStr: string): string {
  return `
    <h1>Daily Crisp Summary — ${dateStr}</h1>
    <p>No conversations yesterday. Quiet day! 🎉</p>
  `;
}

// Returns whether the mail actually went out, so `daily_summaries.emailed`
// records what happened instead of asserting that it did.
async function sendEmail(env: Env, html: string) {
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

  const form = new FormData();
  form.append("from", "Crisp Summary <summary@mg.cartkit.com>");
  form.append("to", "jason@cartkit.com");
  form.append("subject", `Daily Crisp Summary — ${dateStr}`);
  form.append("html", html);

  const response = await fetch(
    "https://api.mailgun.net/v3/mg.cartkit.com/messages",
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`api:${env.MAILGUN_KEY}`),
      },
      body: form,
    }
  );

  if (!response.ok) {
    console.error("Mailgun error:", await response.text());
    return false;
  }

  return true;
}
