// Writing the conversation mirror. See 0011_conversation_log.sql for why it
// exists at all.
//
// Three callers, one function: the webhook (every incoming message, with the
// transcript it had to fetch anyway), the nightly sync (yesterday's
// conversations, in full), and the backfill (all of history, once). They differ
// only in how much of the transcript they hold and whether they can claim it is
// complete, so `syncConversation` takes both as arguments and nothing else
// needs to know which caller it is.

import { Env } from "./index";
import type { CrispConversation, CrispMessage } from "./crisp";

// Crisp types we can store as text. Everything else — files, audio, pickers,
// state events — has no body worth searching, and inventing a placeholder for
// them would corrupt the message counts.
const TEXT_TYPES = new Set(["text", "note"]);

// Returns false on failure, and the parsed body — which is legitimately null
// for the `return=minimal` writes this module makes — on success. The obvious
// shape (null for both) silently reported every successful write as a failed
// one, because a minimal write has no body to parse.
async function supabase(
  env: Env,
  path: string,
  init: RequestInit & { prefer?: string } = {}
): Promise<unknown | false> {
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
    return false;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof (content as any).text === "string") return (content as any).text;
  return "";
}

function roleOf(from: string | undefined) {
  if (from === "user") return "user";
  if (from === "operator") return "operator";
  return "system";
}

export interface ConversationMeta {
  websiteId: string;
  apiKey?: string | null;
  nickname?: string | null;
  email?: string | null;
  state?: string | null;
  // True only when the caller walked the whole history. A webhook never can,
  // so it passes false and leaves any existing `true` alone (see below).
  complete?: boolean;
}

export async function syncConversation(
  env: Env,
  sessionId: string,
  messages: CrispMessage[],
  meta: ConversationMeta
) {
  const usable = messages
    .filter((m) => TEXT_TYPES.has(m.type))
    .map((m) => ({
      session_id: sessionId,
      // Crisp fingerprints are numbers; a handful of very old messages have
      // none, so fall back to something stable for the same message rather
      // than something unique per sync, which would duplicate on every run.
      fingerprint: String(m.fingerprint ?? `${m.timestamp}-${m.from}`),
      from_role: roleOf(m.from),
      origin: (m as any).origin ?? null,
      is_note: m.type === "note",
      author: m.user?.nickname ?? null,
      body: textOf(m.content),
      sent_at: new Date(m.timestamp).toISOString(),
    }))
    .filter((m) => m.body);

  // Two messages in the same conversation sharing a fingerprint would make
  // Postgres reject the whole batch ("cannot affect row a second time"), so
  // the last one wins here rather than losing the entire conversation.
  const byFingerprint = new Map(usable.map((m) => [m.fingerprint, m]));
  const rows = [...byFingerprint.values()];

  const timestamps = rows.map((m) => m.sent_at).sort();
  const firstUser = rows.find((m) => m.from_role === "user");

  // The conversation row has to exist before its messages: they carry a
  // foreign key to it, and the whole batch would be rejected otherwise.
  const conversation: Record<string, unknown> = {
    session_id: sessionId,
    website_id: meta.websiteId,
    synced_at: new Date().toISOString(),
  };

  // Only overwrite what the caller actually knows. A webhook that could not
  // resolve the store must not blank an api_key an earlier sync resolved.
  if (meta.apiKey) conversation.api_key = meta.apiKey;
  if (meta.nickname) conversation.nickname = meta.nickname;
  if (meta.email) conversation.email = meta.email;
  if (meta.state) conversation.state = meta.state;
  if (timestamps.length) {
    conversation.last_at = timestamps[timestamps.length - 1];
    // A webhook sees only the last page, so its "first" message may not be the
    // real one. Claim started_at and first_question only from a full walk.
    if (meta.complete) {
      conversation.started_at = timestamps[0];
      conversation.first_question = firstUser?.body ?? null;
    }
  }
  // `complete` is one-way. A later webhook holding a partial transcript would
  // otherwise demote a conversation the backfill had already finished.
  if (meta.complete) conversation.complete = true;

  const saved = await supabase(env, "/conversations", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify(conversation),
  });

  if (saved === false) return 0;

  // A webhook row has no started_at until something walks the full history.
  // Backstopping it with the earliest message we HAVE keeps the daily metrics
  // from dropping the conversation entirely (they group by started_at), and a
  // later full sync corrects it.
  if (!meta.complete && timestamps.length) {
    await supabase(
      env,
      `/conversations?session_id=eq.${sessionId}&started_at=is.null`,
      {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({
          started_at: timestamps[0],
          first_question: firstUser?.body ?? null,
        }),
      }
    );
  }

  if (!rows.length) return 0;

  const written = await supabase(env, "/conversation_messages", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify(rows),
  });

  if (written === false) return 0;

  // Kept on the conversation so the common "how big was this" question needs
  // no count(*) over the messages table. Recounted from the table rather than
  // from `rows`, because a webhook's partial page would otherwise shrink it.
  await supabase(env, "/rpc/refresh_conversation_count", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify({ p_session_id: sessionId }),
  });

  return rows.length;
}

// Set once the bot has resolved which merchant a conversation belongs to. A
// separate call rather than a second full sync, because by the time the store
// is known the transcript has already been written and re-sending it would be
// three round trips to change one column.
export async function setConversationApiKey(
  env: Env,
  sessionId: string,
  apiKey: string
) {
  await supabase(env, `/conversations?session_id=eq.${sessionId}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ api_key: apiKey }),
  });
}

// Topics the bot matched are a free label — no inference, already computed on
// every answered message. Applied as source 'kb' so a bulk re-classification of
// the model's tags can never touch them.
export async function syncKbTags(env: Env, sessionId: string, topics: string[]) {
  const rows = [...new Set(topics)].filter(Boolean).map((tag) => ({
    session_id: sessionId,
    tag,
    source: "kb",
  }));

  if (!rows.length) return;

  await supabase(env, "/conversation_tags", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: JSON.stringify(rows),
  });
}

export interface ModelTag {
  sessionId: string;
  tag: string;
  note?: string | null;
}

// The nightly analysis's labels. Model tags for the covered conversations are
// cleared first so a re-run cannot leave last night's wrong answer behind —
// which is exactly why human tags are a separate `source` and are not touched.
export async function replaceModelTags(env: Env, sessionIds: string[], tags: ModelTag[]) {
  const scope = [...new Set(sessionIds)].filter(Boolean);
  if (!scope.length) return;

  // PostgREST takes an `in` list in the query string; conversation ids are
  // long, so this goes in batches rather than one enormous URL.
  for (let i = 0; i < scope.length; i += 50) {
    const batch = scope.slice(i, i + 50).map((id) => `"${id}"`).join(",");
    await supabase(
      env,
      `/conversation_tags?source=eq.model&session_id=in.(${batch})`,
      { method: "DELETE", prefer: "return=minimal" }
    );
  }

  const rows = tags
    .filter((t) => t.sessionId && t.tag)
    .map((t) => ({
      session_id: t.sessionId,
      tag: t.tag,
      source: "model",
      note: t.note ?? null,
    }));

  if (!rows.length) return;

  // The analysis can name the same conversation twice (an escalation that is
  // also a topic); ignore-duplicates makes that harmless.
  await supabase(env, "/conversation_tags", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: JSON.stringify(rows),
  });
}

export async function saveDailySummary(
  env: Env,
  summaryDate: string,
  totalCount: number,
  analysis: unknown,
  emailed: boolean
) {
  await supabase(env, "/daily_summaries", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({
      summary_date: summaryDate,
      total_count: totalCount,
      analysis,
      emailed,
    }),
  });
}

export type { CrispConversation };
