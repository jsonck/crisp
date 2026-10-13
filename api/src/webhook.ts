import { Env } from "./index";
import { answerQuestion } from "./answer";
import { WEBSITE_ID, getRecentMessages, postNote, type CrispMessage } from "./crisp";

// If a human has spoken this recently, they're on it — a suggestion note would
// just be noise in a conversation someone is already handling.
const OPERATOR_ACTIVE_WINDOW_MS = 15 * 60 * 1000;

// How much of the conversation the model sees for context.
const HISTORY_LIMIT = 10;

interface WebhookBody {
  event?: string;
  website_id?: string;
  data?: {
    session_id?: string;
    website_id?: string;
    type?: string;
    from?: string;
    origin?: string;
    content?: any;
    fingerprint?: number;
    timestamp?: number;
  };
}

async function supabase(
  env: Env,
  path: string,
  init: RequestInit & { prefer?: string } = {}
) {
  const { prefer, ...rest } = init;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...rest,
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
  });

  if (!response.ok) {
    console.error(`Supabase ${path} ${response.status}:`, await response.text());
    return null;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function textOf(content: any) {
  if (typeof content === "string") return content;
  if (content && typeof content.text === "string") return content.text;
  return "";
}

export async function handleCrispMessage(env: Env, body: WebhookBody) {
  const data = body.data ?? {};
  const sessionId = data.session_id;
  const websiteId = data.website_id ?? body.website_id;

  // `message:send` is visitor -> operators. The bot's own notes fire
  // `message:received`, so this alone prevents a self-reply loop; the
  // `from` check below is the belt to that braces.
  if (body.event !== "message:send") return;
  if (!sessionId || websiteId !== WEBSITE_ID) return;
  if (data.from !== "user") return;
  if (data.type !== "text") return;

  const question = textOf(data.content).trim();
  if (!question) return;

  // Claim the fingerprint BEFORE calling the model. Crisp retries webhooks, and
  // the unique index turns a retry into a no-op rather than a second answer.
  const fingerprint = String(data.fingerprint ?? `${sessionId}:${data.timestamp ?? ""}`);
  const claim = await supabase(env, "/bot_suggestions", {
    method: "POST",
    prefer: "return=representation,resolution=ignore-duplicates",
    body: JSON.stringify({
      website_id: websiteId,
      session_id: sessionId,
      fingerprint,
      question,
    }),
  });

  if (!claim || !Array.isArray(claim) || !claim.length) {
    console.log("Duplicate or unclaimable webhook, skipping:", fingerprint);
    return;
  }
  const rowId = claim[0].id;

  const finish = (patch: Record<string, unknown>) =>
    supabase(env, `/bot_suggestions?id=eq.${rowId}`, {
      method: "PATCH",
      body: JSON.stringify({ ...patch, completed_at: new Date().toISOString() }),
    });

  const messages = await getRecentMessages(env, sessionId);
  if (messages === null) {
    await finish({ skipped: "Could not load the conversation from Crisp." });
    return;
  }

  // Stay quiet if a human is already in the thread. Notes are internal, but an
  // agent mid-conversation does not need the bot talking over them.
  const lastOperator = messages
    .filter((m: CrispMessage) => m.from === "operator" && m.type === "text")
    .reduce((latest: number, m: CrispMessage) => Math.max(latest, m.timestamp ?? 0), 0);

  if (lastOperator && Date.now() - lastOperator < OPERATOR_ACTIVE_WINDOW_MS) {
    await finish({ skipped: "An operator replied within the last 15 minutes." });
    return;
  }

  const history = messages
    .filter((m: CrispMessage) => m.type === "text")
    .slice(-HISTORY_LIMIT)
    .map((m: CrispMessage) => ({
      role: (m.from === "user" ? "user" : "assistant") as "user" | "assistant",
      content: textOf(m.content),
    }))
    .filter((m) => m.content);

  // The current message is already the last entry in the fetched history, so
  // drop it — answerQuestion appends the question itself.
  if (history.length && history[history.length - 1].content === question) history.pop();

  const result = await answerQuestion(env, question, history);

  let posted = false;
  if (result.covered && result.messages.length) {
    const topics = result.topics_used?.length ? result.topics_used.join(", ") : "none";
    // One note, not one per message: three separate notes would clutter the
    // inbox. The numbering shows the team how it would arrive in the chat.
    const draft = result.messages
      .map((m, i) => (result.messages.length > 1 ? `${i + 1}. ${m}` : m))
      .join("\n");
    posted = await postNote(
      env,
      sessionId,
      `🤖 Suggested reply (not sent to the customer)\n\n${draft}\n\n— from knowledge base: ${topics}`
    );
  }

  await finish({
    covered: result.covered,
    answer: result.messages.join("\n") || null,
    reason: result.reason || null,
    topics_used: result.topics_used ?? [],
    posted_note: posted,
    usage: result.usage ?? null,
  });
}
