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
// are calendar days in New York, matching the views and the nightly summary.
// Parsing them into local Date objects is how a dashboard ends up a day out.
export const REPORTING_TZ = "America/New_York";

// Today where the team is, not in UTC. In UTC the dashboard rolls over at 8pm
// Eastern, so "conversations today" reads zero for the last four hours of a
// working evening — which is exactly when someone looks at it.
export function todayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: REPORTING_TZ });
}

function sinceDay(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toLocaleDateString("en-CA", { timeZone: REPORTING_TZ });
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

// Queried from the conversations side, not the tags side, so that ORDER BY and
// LIMIT apply to the thing being listed. Going through conversation_tags meant
// the limit cut an UNORDERED set of tag rows — physical order, so the oldest
// inserted — and the client-side sort then ran on a slice the server had
// already truncated. With 88 tagged conversations and a limit of 50, the most
// recent one on screen was two days stale and nothing looked broken.
export async function getConversationsByTag(tag: string, days: number, limit = 50) {
  await devSignIn;
  const { data, error } = await supabase
    .from("conversations")
    .select("session_id, nickname, email, started_at, msg_count, first_question, conversation_tags!inner(tag)")
    .eq("conversation_tags.tag", tag)
    .gte("started_at", `${sinceDay(days)}T00:00:00Z`)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getConversationsByTag:", error);
    return [];
  }

  // A conversation carrying the same tag from two sources joins twice; the
  // embedded rows are dropped here and the conversation kept once.
  const seen = new Map<string, ConversationHit>();
  for (const row of (data ?? []) as any[]) {
    const { conversation_tags: _ignored, ...conversation } = row;
    if (!seen.has(conversation.session_id)) {
      seen.set(conversation.session_id, conversation as ConversationHit);
    }
  }

  return [...seen.values()];
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

// --- the review funnel -----------------------------------------------------

export interface FunnelDay {
  day: string;
  conversations: number;
  eligible: number;
  asked: number;
  agreed: number;
  claimed: number;
  declined: number;
  reviewed: number;
  qualification_known: number;
  reviewed_known: number;
}

export interface FunnelStage {
  label: string;
  value: number;
  // Share of the stage above, which is the number a funnel exists to show —
  // an absolute count alone cannot say where people are being lost.
  ofPrevious: number | null;
  note?: string;
  // True when we hold no data for this stage at all. A stage that is pending
  // and a stage that is genuinely zero both count zero, and showing them the
  // same way turns "not collected yet" into "nobody qualified".
  pending?: boolean;
}

// Unscoped, the funnel answers a question nobody asked: most conversations are
// bug reports and inbound spam where asking for a review would be wrong, so
// "11% of all conversations get asked" measures restraint, not a leak. The
// scope is what makes the number mean something.
export async function getFunnel(days: number, tag?: string): Promise<FunnelDay[]> {
  await devSignIn;

  if (!tag) {
    const { data, error } = await supabase
      .from("review_funnel_daily")
      .select("*")
      .gte("day", sinceDay(days))
      .order("day");

    if (error) {
      console.error("getFunnel:", error);
      return [];
    }
    return (data ?? []) as FunnelDay[];
  }

  // Scoped: read the per-conversation flags and roll them up here, rather than
  // add a second daily view per possible scope.
  const { data, error } = await supabase
    .from("review_funnel_conversations")
    .select("session_id, day, eligible, asked, agreed, claimed, declined, has_reviewed, qualification, conversation_tags!inner(tag)")
    .eq("conversation_tags.tag", tag)
    .gte("day", sinceDay(days));

  if (error) {
    console.error("getFunnel (scoped):", error);
    return [];
  }

  // A conversation carrying the tag from two sources (kb and model, say)
  // joins twice and must not be counted twice.
  const byConversation = new Map<string, any>();
  for (const row of (data ?? []) as any[]) {
    byConversation.set(row.session_id, row);
  }

  const days_: Record<string, FunnelDay> = {};
  for (const row of byConversation.values()) {
    const d = (days_[row.day] ??= {
      day: row.day,
      conversations: 0,
      eligible: 0,
      asked: 0,
      agreed: 0,
      claimed: 0,
      declined: 0,
      reviewed: 0,
      qualification_known: 0,
      reviewed_known: 0,
    });
    d.conversations++;
    if (row.eligible) d.eligible++;
    if (row.asked) d.asked++;
    if (row.agreed) d.agreed++;
    if (row.claimed) d.claimed++;
    if (row.declined) d.declined++;
    if (row.has_reviewed) d.reviewed++;
    if (row.qualification != null) d.qualification_known++;
    if (row.has_reviewed != null) d.reviewed_known++;
  }

  return Object.values(days_).sort((a, b) => a.day.localeCompare(b.day));
}

export function funnelStages(rows: FunnelDay[]): FunnelStage[] {
  const sum = (k: keyof FunnelDay) =>
    rows.reduce((total, r) => total + Number(r[k] ?? 0), 0);

  const steps: Omit<FunnelStage, "ofPrevious">[] = [
    { label: "Conversations", value: sum("conversations") },
    {
      label: "Eligible to ask",
      value: sum("eligible"),
      note: "Pop Convert says they may be asked (qualification “mango”)",
      pending: sum("qualification_known") === 0,
    },
    { label: "Asked for a review", value: sum("asked") },
    { label: "Said yes", value: sum("agreed") },
    { label: "Said they left one", value: sum("claimed") },
    {
      label: "Has reviewed",
      value: sum("reviewed"),
      note: "Pop Convert’s own flag, as of each conversation’s last sync — a floor, not a total",
      pending: sum("reviewed_known") === 0,
    },
  ];

  // A pending stage is skipped as a denominator too: dividing by a stage we
  // have not collected would print a conversion rate of nothing into infinity.
  return steps.map((step, i) => {
    const previous = steps[i - 1];
    return {
      ...step,
      ofPrevious:
        i === 0 || step.pending || !previous || previous.pending || !previous.value
          ? null
          : step.value / previous.value,
    };
  });
}
