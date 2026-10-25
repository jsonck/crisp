import { Env } from "./index";

// Reading back what the bot already drafted.
//
// The bot runs muted (webhook.ts BOT_MUTED), so every inbound visitor message
// already has an answer computed and stored in `bot_suggestions` — and nobody
// ever sees it. This is the read side of that table, shaped for the Crisp
// side-panel extension so an agent picking up a conversation sees the draft
// instead of the extension inventing its own with a worse prompt.
//
// Nothing here calls the model. A draft is served only if it already exists;
// the cost of this endpoint is one indexed Supabase query.

export interface DraftRow {
  question: string;
  covered: boolean | null;
  answer: string | null;
  reason: string | null;
  topics_used: string[];
  tools_used: string[];
  actions_taken: string[];
  withheld_actions: string[];
  would_send_reason: string | null;
  needs_human: boolean | null;
  muted: boolean;
  reply_sent: boolean;
  posted_note: boolean;
  skipped: string | null;
  created_at: string;
}

export interface DraftResponse {
  session_id: string;
  // The most recent row that actually produced an answer. Null when the bot
  // has never drafted anything for this conversation.
  draft: DraftRow | null;
  // The most recent row of any kind. When this is newer than `draft`, the
  // draft is for an earlier message and the panel must say so rather than
  // present a stale answer as the reply to the message on screen.
  latest: DraftRow | null;
  stale: boolean;
}

const COLUMNS = [
  "question",
  "covered",
  "answer",
  "reason",
  "topics_used",
  "tools_used",
  "actions_taken",
  "withheld_actions",
  "would_send_reason",
  "needs_human",
  "muted",
  "reply_sent",
  "posted_note",
  "skipped",
  "created_at",
].join(",");

async function query(env: Env, filter: string): Promise<DraftRow[] | null> {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/bot_suggestions?select=${COLUMNS}&${filter}`,
    {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      },
    }
  );

  if (!response.ok) {
    console.error("bot_suggestions read failed:", response.status, await response.text());
    return null;
  }
  return (await response.json()) as DraftRow[];
}

/**
 * The latest draft for one Crisp session, plus the latest row of any kind.
 *
 * Two queries rather than one fetch-and-filter: a long watermark conversation
 * can run to dozens of rows, nearly all of them skipped, and pulling the lot
 * to find one answer gets slower exactly as the conversation gets longer.
 */
export async function loadDraft(
  env: Env,
  sessionId: string
): Promise<DraftResponse | null> {
  const session = `session_id=eq.${encodeURIComponent(sessionId)}`;

  const [answered, latest] = await Promise.all([
    // `answer` is null on a row that ran but was not covered, so the filter is
    // on `skipped` — "the bot actually looked at this message" — and the
    // not-covered case is kept, because its `reason` is the useful half.
    query(env, `${session}&skipped=is.null&completed_at=not.is.null&order=created_at.desc&limit=1`),
    query(env, `${session}&order=created_at.desc&limit=1`),
  ]);

  if (answered === null || latest === null) return null;

  const draft = answered[0] ?? null;
  const newest = latest[0] ?? null;

  return {
    session_id: sessionId,
    draft,
    latest: newest,
    stale: Boolean(draft && newest && newest.created_at > draft.created_at),
  };
}
