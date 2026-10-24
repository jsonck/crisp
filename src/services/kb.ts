import { supabase, devSignIn } from "./supabase";

export interface Topic {
  id: string;
  name: string;
  slug: string | null;
  applies_when: string | null;
  enabled: boolean;
  // When true, answers drawn solely from this topic are SENT to the customer
  // rather than posted as a suggestion for an operator. Off by default.
  autonomous: boolean;
  position: number;
  updated_at: string;
}

/**
 * Where an answer can send the merchant. `app` is a path inside Pop Convert,
 * `admin` a path under their own Shopify admin (stored relative, because the
 * shop handle differs per store), `external` an absolute URL. Rendered as
 * buttons by the help centre portal; the bot never sees these.
 */
export interface QaLink {
  label: string;
  kind: "app" | "admin" | "external";
  to: string;
}

/** A picture of the thing the answer is describing. See 0013. */
export interface QaMedia {
  src: string;
  alt: string;
  caption: string | null;
  width: number;
  height: number;
}

export interface QaPair {
  id: string;
  topic_id: string;
  question: string;
  answer: string;
  enabled: boolean;
  position: number;
  tags: string[];
  links: QaLink[];
  media: QaMedia[];
  updated_at: string;
}

// --- auth -----------------------------------------------------------------

export async function getSession() {
  // Locally this is the thing that creates the session; everywhere else it is
  // an already-resolved promise.
  await devSignIn;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function sendMagicLink(email: string) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${window.location.origin}/kb` },
  });
  return error?.message ?? null;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// Distinguishes "logged in but not allowlisted" from "KB is empty", which
// otherwise look identical through RLS.
export async function isKbEditor() {
  await devSignIn;
  const { data, error } = await supabase.rpc("is_kb_editor");
  if (error) {
    console.error("is_kb_editor failed:", error);
    return false;
  }
  return data === true;
}

// --- topics ---------------------------------------------------------------

export async function listTopics() {
  const { data, error } = await supabase
    .from("topics")
    .select("*")
    .order("position")
    .order("created_at");

  if (error) {
    console.error("listTopics:", error);
    return null;
  }
  return data as Topic[];
}

export async function createTopic(name: string, position: number) {
  const { data, error } = await supabase
    .from("topics")
    .insert({ name, position })
    .select("*")
    .single();

  if (error) {
    console.error("createTopic:", error);
    return null;
  }
  return data as Topic;
}

export async function updateTopic(id: string, patch: Partial<Topic>) {
  const { error } = await supabase.from("topics").update(patch).eq("id", id);
  if (error) {
    console.error("updateTopic:", error);
    return error.message;
  }
  return null;
}

export async function deleteTopic(id: string) {
  const { error } = await supabase.from("topics").delete().eq("id", id);
  if (error) {
    console.error("deleteTopic:", error);
    return error.message;
  }
  return null;
}

// --- q&a pairs ------------------------------------------------------------

export async function listQaPairs(topicId: string) {
  const { data, error } = await supabase
    .from("qa_pairs")
    .select("*")
    .eq("topic_id", topicId)
    .order("position")
    .order("created_at");

  if (error) {
    console.error("listQaPairs:", error);
    return null;
  }
  return data as QaPair[];
}

export async function createQaPair(topicId: string, position: number) {
  const { data, error } = await supabase
    .from("qa_pairs")
    .insert({ topic_id: topicId, question: "", answer: "", position })
    .select("*")
    .single();

  if (error) {
    console.error("createQaPair:", error);
    return null;
  }
  return data as QaPair;
}

export async function updateQaPair(id: string, patch: Partial<QaPair>) {
  const { error } = await supabase.from("qa_pairs").update(patch).eq("id", id);
  if (error) {
    console.error("updateQaPair:", error);
    return error.message;
  }
  return null;
}

export async function deleteQaPair(id: string) {
  const { error } = await supabase.from("qa_pairs").delete().eq("id", id);
  if (error) {
    console.error("deleteQaPair:", error);
    return error.message;
  }
  return null;
}

// The whole KB is small enough to load at once, which gives the sidebar its
// per-topic counts for free and makes switching topics instant.
export async function listAllQaPairs() {
  const { data, error } = await supabase
    .from("qa_pairs")
    .select("*")
    .order("position")
    .order("created_at");

  if (error) {
    console.error("listAllQaPairs:", error);
    return null;
  }
  return data as QaPair[];
}

// --- bot testing ----------------------------------------------------------

// In dev, prefer a locally running API if one is configured — otherwise "test
// the bot" silently exercises the DEPLOYED code while you edit the local
// prompt, which is confusing in exactly the way you would expect. Statically
// false in a build, so production always uses the real URL.
const API_URL =
  (import.meta.env.DEV && (import.meta.env.VITE_API_URL_LOCAL as string)) ||
  ((import.meta.env.VITE_WORKER_URL as string) ?? "");

export interface HandoffPlan {
  target: string | null;
  targetName: string | null;
  mentions: string[];
  mentionNames: string[];
  wasAssigned: boolean;
  wouldAssign: boolean;
  someoneOnline: boolean;
  message: string;
}

export interface FlowState {
  askedConfirm: boolean;
  removed: boolean;
  reviewAsked: boolean;
  reviewAllowed: boolean;
  storeUrl: string | null;
}

export interface BotAnswer {
  covered: boolean;
  needs_human?: boolean;
  sendable?: boolean;
  asked_to_confirm?: boolean;
  asked_for_review?: boolean;
  messages: string[];
  topics_used: string[];
  reason?: string;
  tools_used?: string[];
  actions_taken?: string[];
  // Present only when the bot gave up. Simulated: nothing is written to Crisp.
  handoff?: HandoffPlan | null;
  // True when no operator is on shift, in which case a covered answer is sent
  // to the customer even if its topic is still suggest-only.
  nobody_online?: boolean;
  usage?: { cached: number; written: number; input: number; output: number };
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// Asks the API what the bot would say right now, using the live KB. The
// server re-checks editor access with this same token.
//
// `history` is the conversation so far, oldest first — the same thing the Crisp
// webhook assembles from the real transcript, so a multi-turn test exercises
// the prompt that actually ships rather than a cold open.
//
// `apiKey` makes the merchant's real account visible to the bot AND makes its
// tools live: a watermark question will really remove that store's branding.
export async function testQuestion(
  question: string,
  history: ChatTurn[] = [],
  apiKey?: string | null,
  flow?: Partial<FlowState>
) {
  const session = await getSession();
  if (!session) return { error: "Your session expired — sign in again." };

  try {
    const response = await fetch(`${API_URL}/answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        question,
        history,
        ...(apiKey ? { api_key: apiKey } : {}),
        ...(flow ? { flow } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { error: (body as any).error ?? `Request failed (${response.status})` };
    }
    return { answer: (await response.json()) as BotAnswer };
  } catch (e: any) {
    return {
      error:
        e?.message ??
        (import.meta.env.DEV && import.meta.env.VITE_API_URL_LOCAL
          ? `Could not reach the local API at ${API_URL} — is it running? (cd api && npm run dev)`
          : "Could not reach the answering service."),
    };
  }
}
