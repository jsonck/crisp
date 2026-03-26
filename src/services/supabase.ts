import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY
);

export interface Snapshot {
  id?: string;
  session_id: string;
  nickname: string;
  email: string;
  analysis: any;
  messages: any[];
  created_at?: string;
}

export async function publishSnapshot(snapshot: Omit<Snapshot, "id" | "created_at">) {
  const { data, error } = await supabase
    .from("snapshots")
    .insert(snapshot)
    .select("id")
    .single();

  if (error) {
    console.error("Supabase insert error:", error);
    return null;
  }

  return data.id as string;
}

export async function getSnapshot(id: string): Promise<Snapshot | null> {
  const { data, error } = await supabase
    .from("snapshots")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error("Supabase fetch error:", error);
    return null;
  }

  return data as Snapshot;
}
