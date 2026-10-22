// One-off (but safely repeatable) backfill of the conversation mirror.
//
//   cd api
//   CRISP_KEY=... SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//     npx tsx src/scripts/backfill.ts --since 2025-01-01
//
// Flags:
//   --since <YYYY-MM-DD>  stop once conversations are older than this
//   --pages <n>           stop after n pages of 20 (default: no limit)
//   --all                 re-sync conversations already marked complete
//   --tags-only           skip the walk, just rebuild kb tags from bot_suggestions
//
// Every write is an upsert keyed on ids Crisp already assigns, so running this
// twice changes nothing the first run did not already do. By default it skips
// conversations that are already complete, which makes a interrupted run cheap
// to resume — pass --all to force a full re-read.

import {
  WEBSITE_ID,
  fetchAllMessages,
  listConversations,
  type CrispConversation,
} from "../crisp";
import { syncConversation } from "../log";
import type { Env } from "../index";

// Crisp's list endpoint pages 20 at a time, and their API is rate limited.
// Conversations are synced one at a time with a small pause: this runs once,
// and being slow is free in a way a 429 halfway through is not.
const PAUSE_MS = 120;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

// Only the fields the backfill actually touches. The real Env carries keys
// (Anthropic, Mailgun, the webhook secret) that nothing here should need, and
// demanding them would make the script refuse to start for no reason.
const env = {
  CRISP_KEY: requireEnv("CRISP_KEY"),
  SUPABASE_URL: requireEnv("SUPABASE_URL"),
  SUPABASE_SECRET_KEY: requireEnv("SUPABASE_SECRET_KEY"),
} as Env;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A single dropped connection should not end an hour-long walk. Three tries
// with a widening gap, then give up on THAT conversation and carry on — the
// run is resumable, so one skipped conversation costs a re-run, not a restart.
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      console.error(`${label} failed (attempt ${attempt}/3):`, (e as Error)?.message ?? e);
      if (attempt === 3) return null;
      await sleep(attempt * 2000);
    }
  }
  return null;
}

// Same false-on-failure convention as log.ts, and for the same reason: a
// `return=minimal` write succeeds with an empty body.
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

// Which conversations are already fully mirrored, so a resumed run can skip
// straight past them. Paged, because PostgREST caps a response at 1000 rows
// and silently returning the first page would re-sync everything beyond it.
async function alreadyComplete(): Promise<Set<string>> {
  const done = new Set<string>();

  for (let offset = 0; ; offset += 1000) {
    const rows = await supabase(
      `/conversations?select=session_id&complete=is.true&order=session_id&limit=1000&offset=${offset}`
    );
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) done.add(r.session_id);
    if (rows.length < 1000) break;
  }

  return done;
}

// The topics the bot matched, turned into tags on the conversations that are
// now mirrored. Free labels for every conversation the bot ever answered —
// including, for the record, the ones that prompted this whole exercise.
async function backfillKbTags() {
  console.log("Rebuilding kb tags from bot_suggestions...");

  const sessions = await alreadyMirrored();
  let pageCount = 0;
  let written = 0;

  for (let offset = 0; ; offset += 1000) {
    const rows = await supabase(
      `/bot_suggestions?select=session_id,topics_used&topics_used=neq.{}&order=id&limit=1000&offset=${offset}`
    );
    if (!Array.isArray(rows) || !rows.length) break;
    pageCount++;

    // Deduped in memory first: the same topic recurs on every message of a
    // conversation, so a day's rows collapse to a handful of real tags.
    const tags = new Map<string, { session_id: string; tag: string; source: string }>();
    for (const r of rows) {
      if (!sessions.has(r.session_id)) continue;
      for (const tag of r.topics_used ?? []) {
        if (tag) tags.set(`${r.session_id}:${tag}`, { session_id: r.session_id, tag, source: "kb" });
      }
    }

    const batch = [...tags.values()];
    if (batch.length) {
      const ok = await supabase("/conversation_tags", {
        method: "POST",
        prefer: "resolution=ignore-duplicates,return=minimal",
        body: JSON.stringify(batch),
      });
      if (ok !== false) written += batch.length;
    }

    if (rows.length < 1000) break;
  }

  console.log(`kb tags: ${written} written across ${pageCount} page(s) of suggestions`);
}

// A tag's foreign key points at `conversations`, so a suggestion whose
// conversation was never mirrored (deleted in Crisp, or outside the window
// this backfill covered) has to be dropped rather than fail the batch.
async function alreadyMirrored(): Promise<Set<string>> {
  const seen = new Set<string>();

  for (let offset = 0; ; offset += 1000) {
    const rows = await supabase(
      `/conversations?select=session_id&order=session_id&limit=1000&offset=${offset}`
    );
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) seen.add(r.session_id);
    if (rows.length < 1000) break;
  }

  return seen;
}

async function main() {
  if (flag("tags-only")) {
    await backfillKbTags();
    return;
  }

  const since = arg("since") ? new Date(`${arg("since")}T00:00:00Z`).getTime() : null;
  const maxPages = arg("pages") ? Number(arg("pages")) : Infinity;
  const force = flag("all");

  const skip = force ? new Set<string>() : await alreadyComplete();
  console.log(
    `Backfilling${since ? ` since ${arg("since")}` : " all history"}` +
      (skip.size ? `, skipping ${skip.size} already complete` : "")
  );

  let page = 1;
  let synced = 0;
  let skipped = 0;
  let messages = 0;
  let failed = 0;
  let stop = false;

  while (page <= maxPages && !stop) {
    const batch = await withRetry(`page ${page}`, () => listConversations(env, page));
    if (batch === null) {
      console.error(`Giving up at page ${page} — Crisp would not answer`);
      break;
    }
    if (!batch.length) break;

    for (const conv of batch as CrispConversation[]) {
      // The list is ordered by updated_at desc, so the first conversation
      // older than the cutoff means every one after it is too.
      if (since && (conv.updated_at ?? 0) < since) {
        stop = true;
        break;
      }

      if (skip.has(conv.session_id)) {
        skipped++;
        continue;
      }

      const history = await withRetry(`messages ${conv.session_id}`, () =>
        fetchAllMessages(env, conv.session_id)
      );
      if (!history) {
        console.error("No messages for", conv.session_id);
        failed++;
        continue;
      }

      const written = await withRetry(`sync ${conv.session_id}`, () =>
        syncConversation(env, conv.session_id, history, {
          websiteId: WEBSITE_ID,
          apiKey: typeof conv.meta?.data?.api_key === "string" ? conv.meta.data.api_key : null,
          nickname: conv.meta?.nickname ?? null,
          email: conv.meta?.email ?? null,
          state: conv.state ?? null,
          complete: true,
        })
      );

      if (written === null) {
        failed++;
        continue;
      }

      synced++;
      messages += written;
      if (synced % 25 === 0) {
        console.log(`  ${synced} conversations, ${messages} messages`);
      }

      await sleep(PAUSE_MS);
    }

    page++;
  }

  console.log(
    `Done: ${synced} conversations synced (${messages} messages), ` +
      `${skipped} already complete, ${failed} failed` +
      (failed ? " — re-run to pick them up" : "")
  );

  await backfillKbTags();
}

main().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
