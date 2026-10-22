// Reads for the pulse page.
//
// Straight to Supabase rather than through the API's /metrics endpoint: the
// views are defined `security_invoker`, so an editor's own JWT is what decides
// what they can see, and the same RLS that protects the KB protects this. The
// endpoint exists for anything that is not a logged-in browser.

import { supabase, devSignIn } from "./supabase";

export interface DailyVolume {
  day: string;
  conversations: number;
  identified: number;
  messages: number;
  resolved: number;
}

export interface TagDay {
  day: string;
  tag: string;
  source: "human" | "model" | "kb";
  conversations: number;
}

export interface TagTotal {
  tag: string;
  conversations: number;
  // Which sources contributed, so a tag nobody has ever confirmed by hand is
  // visibly different from one an editor has stood behind.
  sources: string[];
}

export interface ConversationHit {
  session_id: string;
  nickname: string | null;
  email: string | null;
  started_at: string | null;
  msg_count: number;
  first_question: string | null;
  // The matching line, so a search result can be judged without opening it.
  excerpt?: string;
}

// Days are returned as YYYY-MM-DD and compared as strings throughout: these
// are calendar days in the database's timezone, and parsing them into local
// Date objects is how a dashboard ends up a day out.
function sinceDay(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

export async function getDailyVolume(days: number): Promise<DailyVolume[]> {
  await devSignIn;
  const { data, error } = await supabase
    .from("conversation_daily")
    .select("*")
    .gte("day", sinceDay(days))
    .order("day");

  if (error) {
    console.error("getDailyVolume:", error);
    return [];
  }
  return (data ?? []) as DailyVolume[];
}

export async function getTagDays(days: number): Promise<TagDay[]> {
  await devSignIn;
  const { data, error } = await supabase
    .from("conversation_tag_daily")
    .select("*")
    .gte("day", sinceDay(days))
    .order("day");

  if (error) {
    console.error("getTagDays:", error);
    return [];
  }
  return (data ?? []) as TagDay[];
}

// Collapsed across days and sources. A conversation carrying the same tag from
// both the model and an editor must count once, which is why this sums per
// (tag, day) maxima rather than summing every row.
export function totalsByTag(rows: TagDay[]): TagTotal[] {
  const byTag = new Map<string, { perDay: Map<string, number>; sources: Set<string> }>();

  for (const r of rows) {
    const entry = byTag.get(r.tag) ?? { perDay: new Map(), sources: new Set<string>() };
    entry.perDay.set(r.day, Math.max(entry.perDay.get(r.day) ?? 0, r.conversations));
    entry.sources.add(r.source);
    byTag.set(r.tag, entry);
  }

  return [...byTag.entries()]
    .map(([tag, { perDay, sources }]) => ({
      tag,
      conversations: [...perDay.values()].reduce((a, b) => a + b, 0),
      sources: [...sources].sort(),
    }))
    .sort((a, b) => b.conversations - a.conversations);
}

// Median, not mean: one conversation answered three days later would drag an
// average somewhere no real customer experienced.
export async function getMedianFirstResponse(days: number): Promise<number | null> {
  await devSignIn;
  const { data, error } = await supabase
    .from("conversation_first_response")
    .select("first_response_seconds")
    .gte("day", sinceDay(days))
    .gt("first_response_seconds", 0)
    .order("first_response_seconds");

  if (error) {
    console.error("getMedianFirstResponse:", error);
    return null;
  }

  const values = (data ?? []).map((r: any) => r.first_response_seconds as number);
  if (!values.length) return null;
  return values[Math.floor(values.length / 2)];
}

// Full-text over what was actually said. `config: "english"` matters — it makes
// the query match the expression the GIN index was built on; without it
// Postgres falls back to the server default and quietly seq-scans.
export async function searchConversations(query: string, limit = 50) {
  await devSignIn;
  const trimmed = query.trim();
  if (!trimmed) return [];

  const { data, error } = await supabase
    .from("conversation_messages")
    .select("session_id, body, sent_at")
    .textSearch("body", trimmed, { type: "websearch", config: "english" })
    .order("sent_at", { ascending: false })
    .limit(500);

  if (error) {
    console.error("searchConversations:", error);
    return [];
  }

  // One row per conversation, keeping the most recent matching line as the
  // excerpt. A conversation that says "watermark" nine times is one result.
  const bySession = new Map<string, string>();
  for (const row of data ?? []) {
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, row.body);
  }

  const ids = [...bySession.keys()].slice(0, limit);
  if (!ids.length) return [];

  const { data: convs, error: convError } = await supabase
    .from("conversations")
    .select("session_id, nickname, email, started_at, msg_count, first_question")
    .in("session_id", ids)
    .order("started_at", { ascending: false });

  if (convError) {
    console.error("searchConversations (conversations):", convError);
    return [];
  }

  return (convs ?? []).map((c: any) => ({
    ...c,
    excerpt: bySession.get(c.session_id),
  })) as ConversationHit[];
}

export async function getConversationsByTag(tag: string, days: number, limit = 50) {
  await devSignIn;
  const { data, error } = await supabase
    .from("conversation_tags")
    .select("session_id, conversations!inner(session_id, nickname, email, started_at, msg_count, first_question)")
    .eq("tag", tag)
    .gte("conversations.started_at", `${sinceDay(days)}T00:00:00Z`)
    .limit(limit);

  if (error) {
    console.error("getConversationsByTag:", error);
    return [];
  }

  // The join returns one row per (conversation, source); dedupe to conversations.
  const seen = new Map<string, ConversationHit>();
  for (const row of (data ?? []) as any[]) {
    const c = row.conversations;
    if (c && !seen.has(c.session_id)) seen.set(c.session_id, c as ConversationHit);
  }

  return [...seen.values()].sort((a, b) =>
    (b.started_at ?? "").localeCompare(a.started_at ?? "")
  );
}

export interface ConversationTag {
  tag: string;
  source: "human" | "model" | "kb";
  note: string | null;
  tagged_by: string | null;
}

export async function getTags(sessionId: string): Promise<ConversationTag[]> {
  await devSignIn;
  const { data, error } = await supabase
    .from("conversation_tags")
    .select("tag, source, note, tagged_by")
    .eq("session_id", sessionId)
    .order("source");

  if (error) {
    console.error("getTags:", error);
    return [];
  }
  return (data ?? []) as ConversationTag[];
}

// Editors may only write source='human' — enforced by RLS, not just here, so a
// bulk re-classification can never clobber what a person typed.
export async function addTag(sessionId: string, tag: string) {
  await devSignIn;
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { error } = await supabase.from("conversation_tags").insert({
    session_id: sessionId,
    tag: tag.trim(),
    source: "human",
    tagged_by: session?.user?.email ?? null,
  });

  if (error && error.code !== "23505") {
    console.error("addTag:", error);
    return error.message;
  }
  return null;
}

export async function removeTag(sessionId: string, tag: string) {
  await devSignIn;
  const { error } = await supabase
    .from("conversation_tags")
    .delete()
    .eq("session_id", sessionId)
    .eq("tag", tag)
    .eq("source", "human");

  if (error) {
    console.error("removeTag:", error);
    return error.message;
  }
  return null;
}
