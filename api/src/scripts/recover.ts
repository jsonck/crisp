// Rebuild what the mirror is missing from data we already hold, with no Crisp
// calls at all.
//
//   cd api
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... npx tsx src/scripts/recover.ts
//
// Why this is possible: the webhook claims a fingerprint in `bot_suggestions`
// — with the visitor's message text — BEFORE it calls Crisp. So every message
// the bot was woken for is recorded locally even when the Crisp fetch that
// followed it failed. When the plugin token ran out of quota, the mirror
// stopped but that claim did not.
//
// The fingerprint is the same id in both tables (the webhook takes it straight
// from the Crisp payload), which makes this exact rather than approximate, and
// makes it self-correcting: when Crisp is readable again, the nightly sync
// upserts the real message over the reconstructed one on the same primary key.
//
// What this CANNOT recover: operator replies, notes, and anything the bot was
// never woken for. Those exist only in Crisp. Conversations written here are
// deliberately left `complete = false` so the nightly sync still fills them in.

import type { Env } from "../index";

const WEBSITE_ID = "293e3fde-cb94-4151-b17c-33ddbb80ca09";

// Marks a message as reconstructed rather than read from Crisp. It occupies
// the `origin` column because that column's job is to say where a message came
// from — and when the real one arrives it overwrites this on the same key, so
// the marker disappears exactly when it stops being true.
const RECOVERED_ORIGIN = "recovered:bot_suggestions";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const env = {
  SUPABASE_URL: requireEnv("SUPABASE_URL"),
  SUPABASE_SECRET_KEY: requireEnv("SUPABASE_SECRET_KEY"),
} as Env;

const dryRun = process.argv.includes("--dry-run");

async function supabase(
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

interface Suggestion {
  session_id: string;
  website_id: string;
  fingerprint: string;
  question: string;
  created_at: string;
  topics_used: string[] | null;
}

async function page<T>(path: string): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await supabase(`${path}&limit=1000&offset=${offset}`);
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...(batch as T[]));
    if (batch.length < 1000) break;
  }
  return rows;
}

async function main() {
  const suggestions = await page<Suggestion>(
    "/bot_suggestions?select=session_id,website_id,fingerprint,question,created_at,topics_used&order=id"
  );
  const mirrored = await page<{ session_id: string; fingerprint: string }>(
    "/conversation_messages?select=session_id,fingerprint&order=session_id"
  );
  const conversations = await page<{ session_id: string }>(
    "/conversations?select=session_id&order=session_id"
  );

  const haveMessage = new Set(mirrored.map((m) => `${m.session_id}:${m.fingerprint}`));
  const haveConversation = new Set(conversations.map((c) => c.session_id));

  const missing = suggestions.filter(
    (s) => s.fingerprint && s.question && !haveMessage.has(`${s.session_id}:${s.fingerprint}`)
  );

  if (!missing.length) {
    console.log("Nothing to recover — every claimed message is already mirrored.");
    return;
  }

  // Conversations have to exist before their messages; the message rows carry
  // a foreign key to them.
  const newConversations = new Map<string, { started: string; first: string; website: string }>();
  for (const s of missing) {
    if (haveConversation.has(s.session_id)) continue;
    const existing = newConversations.get(s.session_id);
    if (!existing || s.created_at < existing.started) {
      newConversations.set(s.session_id, {
        started: s.created_at,
        first: s.question,
        website: s.website_id || WEBSITE_ID,
      });
    }
  }

  console.log(
    `${missing.length} message(s) to recover across ${new Set(missing.map((s) => s.session_id)).size} ` +
      `conversation(s); ${newConversations.size} conversation row(s) to create`
  );

  if (dryRun) {
    for (const s of missing.slice(0, 10)) {
      console.log(`  ${s.created_at} ${s.session_id} ${s.question.slice(0, 60)}`);
    }
    console.log("(dry run — nothing written)");
    return;
  }

  if (newConversations.size) {
    const rows = [...newConversations.entries()].map(([session_id, v]) => ({
      session_id,
      website_id: v.website,
      started_at: v.started,
      last_at: v.started,
      first_question: v.first,
      // Never true: the operator side of these is still only in Crisp, and the
      // nightly sync must know there is more to fetch.
      complete: false,
    }));

    const ok = await supabase("/conversations", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify(rows),
    });
    if (ok === false) return;
    console.log(`  created ${rows.length} conversation row(s)`);
  }

  // `created_at` is when the webhook handled the message, a second or two
  // after the customer sent it. Close enough to order a transcript by and to
  // bucket into a day; the real timestamp replaces it on the next real sync.
  const messageRows = missing.map((s) => ({
    session_id: s.session_id,
    fingerprint: s.fingerprint,
    from_role: "user",
    origin: RECOVERED_ORIGIN,
    is_note: false,
    author: null,
    body: s.question,
    sent_at: s.created_at,
  }));

  for (let i = 0; i < messageRows.length; i += 500) {
    const chunk = messageRows.slice(i, i + 500);
    const ok = await supabase("/conversation_messages", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify(chunk),
    });
    if (ok === false) return;
    console.log(`  wrote ${chunk.length} message(s)`);
  }

  // Counts are derived, so they have to be refreshed for every conversation
  // that just gained messages.
  for (const sessionId of new Set(missing.map((s) => s.session_id))) {
    await supabase("/rpc/refresh_conversation_count", {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify({ p_session_id: sessionId }),
    });
  }

  // The topics the bot matched are already on these rows; now that their
  // conversations exist, they can carry the tag.
  const tags = new Map<string, { session_id: string; tag: string; source: string }>();
  for (const s of missing) {
    for (const tag of s.topics_used ?? []) {
      if (tag) tags.set(`${s.session_id}:${tag}`, { session_id: s.session_id, tag, source: "kb" });
    }
  }

  if (tags.size) {
    await supabase("/conversation_tags", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=minimal",
      body: JSON.stringify([...tags.values()]),
    });
    console.log(`  applied ${tags.size} kb tag(s)`);
  }

  console.log("Done. These conversations hold the visitor side only — the nightly");
  console.log("sync will fill in operator replies once Crisp is readable again.");
}

main().catch((e) => {
  console.error("Recovery failed:", e);
  process.exit(1);
});
