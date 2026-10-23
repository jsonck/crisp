// Classify the review ask from mirrored transcripts. No Crisp calls.
//
//   cd api
//   ANTHROPIC_API_KEY=... SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//     npx tsx src/scripts/classify-reviews.ts --since 2026-10-01
//
//   --since <YYYY-MM-DD>  earliest conversation start (default: last 7 days)
//   --until <YYYY-MM-DD>  latest conversation start (default: today)
//   --batch <n>           conversations per model call (default 25)
//   --redo                re-classify conversations that already carry a tag
//   --dry-run             print the classification, write nothing
//
// The nightly summary does this too, as part of its daily pass. This exists
// because the two things come apart: the summary reads transcripts from Crisp
// and dies when the plugin token is out of quota, while every transcript it
// would have read is already in conversation_messages. It is also how you
// classify history — the summary only ever looks at yesterday.
//
// Only the review question is asked here, deliberately. A narrow prompt over a
// transcript is a thing a model is reliably good at; it is also auditable,
// because every tag it writes carries the customer's own words as its note.

import type { Env } from "../index";

const MODEL = "claude-sonnet-4-6";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const dryRun = process.argv.includes("--dry-run");
const redo = process.argv.includes("--redo");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const env = {
  ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY"),
  SUPABASE_URL: requireEnv("SUPABASE_URL"),
  SUPABASE_SECRET_KEY: requireEnv("SUPABASE_SECRET_KEY"),
} as Env;

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

const OUTCOMES = ["asked", "agreed", "declined", "claimed"] as const;
type Outcome = (typeof OUTCOMES)[number];

interface Review {
  session_id: string;
  outcome: Outcome;
  quote?: string;
}

// Identical wording to the nightly summary's review rules, on purpose: two
// prompts that drift produce two incompatible sets of tags in one column.
const RULES = `For each conversation, decide whether an agent asked the customer to leave a review, and what the customer said back. Use the strongest outcome actually supported by the customer's words:
  "asked"    -> they were asked and did not answer either way
  "declined" -> they said no, deflected, or put it off
  "agreed"   -> they said yes, or asked where to leave it
  "claimed"  -> they said they had already left it ("done", "just left you 5 stars")

Report what was SAID, nothing more. "sure, send the link" is agreed, never claimed. Leave a conversation out of the array entirely if no review was asked for — that is the right answer for most of them. The quote must be the customer's words copied exactly, so a human can check the call.

Respond with valid JSON only, no markdown fences:
{"review": [{"session_id": "...", "outcome": "asked|agreed|declined|claimed", "quote": "..."}]}`;

// Models wrap JSON in markdown fences no matter how firmly the prompt says not
// to, and a fenced response is a correct answer we would otherwise throw away.
// Strip the fence rather than re-prompt.
function parseJsonResponse<T>(text: string | undefined): T | null {
  if (!text) return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

async function classify(transcripts: string[]): Promise<Review[]> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: "user", content: `${RULES}\n\n${transcripts.join("\n\n")}` }],
    }),
  });

  if (!response.ok) {
    console.error("Anthropic error:", await response.text());
    return [];
  }

  const json = (await response.json()) as {
    content: { text: string }[];
    stop_reason?: string;
  };

  if (json.stop_reason === "max_tokens") {
    console.error("Response truncated — use a smaller --batch");
    return [];
  }

  const parsed = parseJsonResponse<{ review?: Review[] }>(json.content?.[0]?.text);
  if (!parsed) {
    console.error("Could not parse:", json.content?.[0]?.text?.slice(0, 300));
    return [];
  }

  return (parsed.review ?? []).filter(
    (r: Review) => r?.session_id && OUTCOMES.includes(r.outcome)
  );
}

async function main() {
  const until = arg("until") ?? new Date().toISOString().slice(0, 10);
  const since =
    arg("since") ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const batchSize = Number(arg("batch") ?? 25);

  const conversations = await page<{ session_id: string; nickname: string | null }>(
    `/conversations?select=session_id,nickname&started_at=gte.${since}T00:00:00Z` +
      `&started_at=lt.${until}T23:59:59Z&order=started_at`
  );

  if (!conversations.length) {
    console.log("No conversations in that range.");
    return;
  }

  // Skip anything already judged, so a re-run costs nothing and so a human
  // tag is never silently overwritten by a model one.
  let todo = conversations;
  if (!redo) {
    const tagged = new Set(
      (
        await page<{ session_id: string }>(
          "/conversation_tags?select=session_id&tag=like.review-*&order=session_id"
        )
      ).map((t) => t.session_id)
    );
    todo = conversations.filter((c) => !tagged.has(c.session_id));
  }

  console.log(
    `${conversations.length} conversation(s) from ${since} to ${until}; ` +
      `${todo.length} to classify in batches of ${batchSize}`
  );
  if (!todo.length) return;

  const found: Review[] = [];

  for (let i = 0; i < todo.length; i += batchSize) {
    const chunk = todo.slice(i, i + batchSize);
    const transcripts: string[] = [];

    for (const c of chunk) {
      // Notes excluded: an internal note is not something the customer saw,
      // and a note saying "asked for a review" would be read as the ask.
      const messages = await page<{ from_role: string; author: string | null; body: string }>(
        `/conversation_messages?select=from_role,author,body&session_id=eq.${c.session_id}` +
          `&is_note=is.false&order=sent_at`
      );
      if (!messages.length) continue;

      const lines = messages
        .map((m) => `${m.from_role === "user" ? "Customer" : m.author || "Agent"}: ${m.body}`)
        .join("\n");
      transcripts.push(`--- [session_id: ${c.session_id}] ---\n${lines}`);
    }

    if (!transcripts.length) continue;

    const reviews = await classify(transcripts);
    found.push(...reviews);
    console.log(
      `  batch ${Math.floor(i / batchSize) + 1}: ${transcripts.length} conversations -> ${reviews.length} with a review ask`
    );
  }

  if (dryRun) {
    for (const r of found) {
      console.log(`  ${r.outcome.padEnd(8)} ${r.session_id.slice(-12)}  "${(r.quote ?? "").slice(0, 70)}"`);
    }
    console.log(`(dry run — ${found.length} judgement(s), nothing written)`);
    return;
  }

  // Every outcome implies the ask happened: "agreed" has to be a subset of
  // "asked" or the conversion between the two steps means nothing.
  const rows: { session_id: string; tag: string; source: string; note: string | null }[] = [];
  for (const r of found) {
    rows.push({ session_id: r.session_id, tag: "review-asked", source: "model", note: r.quote ?? null });
    if (r.outcome !== "asked") {
      rows.push({ session_id: r.session_id, tag: `review-${r.outcome}`, source: "model", note: r.quote ?? null });
    }
  }

  if (!rows.length) {
    console.log("No review asks found.");
    return;
  }

  const ok = await supabase("/conversation_tags", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify(rows),
  });

  if (ok === false) return;
  console.log(`Wrote ${rows.length} tag(s) across ${found.length} conversation(s).`);
}

main().catch((e) => {
  console.error("Classification failed:", e);
  process.exit(1);
});
