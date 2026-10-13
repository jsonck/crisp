import { supabase } from "./supabase";

export interface Topic {
  id: string;
  name: string;
  slug: string | null;
  applies_when: string | null;
  enabled: boolean;
  position: number;
  updated_at: string;
}

export interface QaPair {
  id: string;
  topic_id: string;
  question: string;
  answer: string;
  enabled: boolean;
  position: number;
  tags: string[];
  updated_at: string;
}

// --- auth -----------------------------------------------------------------

export async function getSession() {
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

const WORKER_URL = (import.meta.env.VITE_WORKER_URL as string) ?? "";

export interface BotAnswer {
  covered: boolean;
  messages: string[];
  topics_used: string[];
  reason?: string;
  usage?: { cached: number; written: number; input: number; output: number };
}

// Asks the worker what the bot would say right now, using the live KB. The
// worker re-checks editor access with this same token.
export async function testQuestion(question: string) {
  const session = await getSession();
  if (!session) return { error: "Your session expired — sign in again." };

  try {
    const response = await fetch(`${WORKER_URL}/answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ question }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { error: (body as any).error ?? `Request failed (${response.status})` };
    }
    return { answer: (await response.json()) as BotAnswer };
  } catch (e: any) {
    return { error: e?.message ?? "Could not reach the answering service." };
  }
}
