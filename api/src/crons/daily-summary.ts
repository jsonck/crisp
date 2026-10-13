import { Env } from "../index";

const CRISP_IDENTIFIER = "012fbb8d-c0a4-45df-a7f1-33b976790cd0";
const WEBSITE_ID = "293e3fde-cb94-4151-b17c-33ddbb80ca09";

interface Message {
  from: string;
  type: string;
  content: string;
  timestamp: number;
  user?: { nickname?: string };
}

interface Conversation {
  session_id: string;
  meta?: { nickname?: string; email?: string };
  updated_at: number;
  state: string;
  last_message?: string;
}

interface AnalysisResult {
  conversations: ConversationSummary[];
  escalated: ConversationSummary[];
  went_well: ConversationSummary[];
  topics: TopicCategory[];
  total_count: number;
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
    await sendEmail(env, formatEmptyDay(yesterday.dateStr));
    return;
  }

  // Fetch messages for each conversation
  const conversationsWithMessages = await Promise.all(
    conversations.map(async (conv) => ({
      ...conv,
      messages: await fetchAllMessages(env, conv.session_id),
    }))
  );

  // Analyze with Claude
  const analysis = await analyzeWithClaude(env, conversationsWithMessages);

  // Format and send
  const html = formatSummaryEmail(yesterday.dateStr, analysis);
  await sendEmail(env, html);
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

  return { startOfDay, endOfDay, dateStr };
}

async function crispGet(env: Env, path: string) {
  const headers = {
    Authorization: "Basic " + btoa(`${CRISP_IDENTIFIER}:${env.CRISP_KEY}`),
    "X-Crisp-Tier": "plugin",
  };

  const response = await fetch(
    `https://api.crisp.chat/v1${path}`,
    { headers }
  );

  if (!response.ok) return null;
  const json = (await response.json()) as { data: any };
  return json.data;
}

async function fetchYesterdayConversations(
  env: Env,
  yesterday: { startOfDay: number; endOfDay: number }
): Promise<Conversation[]> {
  const allConversations: Conversation[] = [];
  let page = 1;

  while (true) {
    const data = await crispGet(
      env,
      `/website/${WEBSITE_ID}/conversations/${page}`
    );
    if (!Array.isArray(data) || data.length === 0) break;

    for (const conv of data) {
      const updatedAt = conv.updated_at;
      if (updatedAt >= yesterday.startOfDay && updatedAt <= yesterday.endOfDay) {
        allConversations.push(conv);
      } else if (updatedAt < yesterday.startOfDay) {
        // Conversations are sorted by updated_at desc, so we can stop
        return allConversations;
      }
    }

    page++;
    if (page > 50) break; // safety limit
  }

  return allConversations;
}

async function fetchAllMessages(
  env: Env,
  sessionId: string
): Promise<Message[]> {
  let allMessages: Message[] = [];
  let timestampBefore: number | undefined;

  while (true) {
    const query = timestampBefore
      ? `?timestamp_before=${timestampBefore}`
      : "";
    const batch = await crispGet(
      env,
      `/website/${WEBSITE_ID}/conversation/${sessionId}/messages${query}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;

    allMessages = [...batch, ...allMessages];
    if (batch.length < 20) break;
    timestampBefore = batch[0].timestamp;
  }

  return allMessages;
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
    { "nickname": "<customer name>", "email": "<email>", "session_id": "<session_id from the transcript>", "reason": "<brief reason why this was escalated or problematic>" }
  ],
  "went_well": [
    { "nickname": "<customer name>", "email": "<email>", "session_id": "<session_id from the transcript>", "reason": "<brief reason why this went well>" }
  ],
  "topics": [
    {
      "name": "<Parent Category>",
      "count": <number of conversations>,
      "subtopics": [
        { "name": "<specific subtopic>", "count": <number> }
      ]
    }
  ],
  "total_count": ${conversations.length}
}

Rules:
- "escalated": conversations where the customer was frustrated/angry, the issue wasn't resolved, the agent struggled, or the customer threatened to leave/asked for a refund. Be selective — only flag truly problematic ones.
- "went_well": conversations where the customer expressed gratitude, the issue was resolved quickly, or the agent went above and beyond. Be selective — only flag genuinely positive ones.
- "topics": group ALL conversations into parent categories, then break each into specific subtopics. Every conversation should be counted in exactly one subtopic.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Anthropic error:", errText);
    return { conversations: [], escalated: [], went_well: [], topics: [], total_count: conversations.length };
  }

  const json = (await response.json()) as { content: { text: string }[]; stop_reason?: string };
  const text = json.content?.[0]?.text;
  const stopReason = json.stop_reason;

  if (stopReason === "max_tokens") {
    console.error("Claude response truncated (max_tokens). Response length:", text?.length);
  }

  try {
    return JSON.parse(text) as AnalysisResult;
  } catch {
    console.error("Failed to parse Claude response. stop_reason:", stopReason, "text:", text?.substring(0, 500));
    return { conversations: [], escalated: [], went_well: [], topics: [], total_count: conversations.length };
  }
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
  }
}
