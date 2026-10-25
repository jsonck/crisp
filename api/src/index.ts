import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { dailySummary } from "./crons/daily-summary";
import { answerQuestion } from "./answer";
import { loadPortal } from "./kb";
import { loadDraft } from "./draft";
import { handleCrispMessage, BOT_ENABLED, BOT_MUTED } from "./webhook";
import { verifySignature } from "./crisp";
import { planHandoff } from "./handoff";
import { isAnyoneOnline } from "./crisp";
import { EMPTY_FLOW, type FlowState } from "./flow";
import { fetchSiteContext } from "./site";

export interface Env {
  CRISP_KEY: string;
  ANTHROPIC_API_KEY: string;
  MAILGUN_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  CRISP_WEBHOOK_SECRET: string;
  PC_BASE_URL: string;
  EXT_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

// Answering burns Anthropic tokens, and this service is on a public URL, so the
// caller has to prove they're an allowlisted KB editor. Rather than verifying
// the JWT here, we hand the caller's own token back to Supabase and let
// is_kb_editor() decide — the check can never drift from the allowlist.
async function isEditor(env: Env, authHeader: string | undefined) {
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) return false;

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/is_kb_editor`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) return false;
  return (await response.json()) === true;
}

// The Crisp side-panel extension reads drafts with a shared secret rather than
// an editor JWT. Deliberate: the extension is an internal tool the support team
// loads unpacked, it has no login screen and no redirect URL a Supabase magic
// link could come back to, and it already ships a far stronger credential (the
// Pop Convert admin password) the same way. The secret buys one thing — /draft
// is not readable by anyone who finds the URL.
//
// Scoped to reads of material the agent is already looking at in Crisp.
// Anything that spends money or changes an account stays on isEditor.
function isExtension(env: Env, secret: string | undefined) {
  const expected = env.EXT_SECRET;
  if (!expected || !secret) return false;
  // Constant-time, and length-checked first: timingSafeEqual throws on a
  // length mismatch, which would leak the length back as a 500.
  const given = Buffer.from(secret);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

app.get("/", (c) => {
  return c.json({ message: "Hello from Crisp API!" });
});

// Render pings this to decide whether the instance is healthy. Deliberately
// does no I/O on the public path: a health check that talks to Supabase turns
// someone else's outage into our instance being replaced.
//
// The bot switches are the first thing to check when the bot has gone quiet —
// off means nothing is even logged, muted means it is all logged and none of
// it sent — so they stay available, but only to an editor. Told to anyone who
// asks, they amount to telling a prober whether the bot is awake. Render sends
// no Authorization header, so its check still costs nothing.
app.get("/health", async (c) => {
  const base = { ok: true, uptime: process.uptime() };
  if (!c.req.header("Authorization")) return c.json(base);
  if (!(await isEditor(c.env, c.req.header("Authorization")))) return c.json(base);
  return c.json({ ...base, bot_enabled: BOT_ENABLED, bot_muted: BOT_MUTED });
});

// Runs the nightly summary on demand. Editor-gated, and it must stay that way:
// this is not a read. It walks Crisp, spends Anthropic tokens and sends mail,
// so ungated it is a way for a stranger to run up a bill and flood an inbox by
// holding down a key.
app.get("/test-summary", async (c) => {
  if (!(await isEditor(c.env, c.req.header("Authorization")))) {
    return c.json({ error: "Not a knowledge base editor" }, 403);
  }
  await dailySummary(c.env);
  return c.json({ message: "Summary sent!" });
});

// Powers the "test this question" box in the KB editor. Same code path the
// Crisp webhook will use, so what you see here is what a customer would get.
app.post("/answer", async (c) => {
  if (!(await isEditor(c.env, c.req.header("Authorization")))) {
    return c.json({ error: "Not a knowledge base editor" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return c.json({ error: "A question is required" }, 400);

  // Optional api_key lets the editor preview what a specific merchant would be
  // told, with their plan and trial state filled in. Tools run for real against
  // that account — `actions_taken` in the response says whether one changed
  // anything, and the editor surfaces it.
  const apiKey = body?.api_key ?? null;
  const siteContext = await fetchSiteContext(c.env, apiKey);

  // History arrives oldest-first, same shape the webhook builds from Crisp.
  const history = Array.isArray(body?.history)
    ? body.history
        .filter(
          (m: any) =>
            (m?.role === "user" || m?.role === "assistant") &&
            typeof m?.content === "string" &&
            m.content.trim()
        )
        .slice(-10)
        .map((m: any) => ({ role: m.role, content: m.content }))
    : [];

  // The tester has no Crisp session, so flow state is supplied by the caller —
  // the editor tracks it from the step markers in each previous reply. Same
  // shape the webhook loads from the database, so the script behaves the same.
  const flow: FlowState = {
    ...EMPTY_FLOW,
    ...(body?.flow && typeof body.flow === "object" ? body.flow : {}),
    storeUrl: body?.flow?.storeUrl ?? body?.store_url ?? null,
  };

  const result = await answerQuestion(c.env, question, history, siteContext, apiKey, flow);

  // When the bot gives up, show what the handoff WOULD do. planHandoff reads
  // live routing and availability but writes nothing to Crisp, so reviewing the
  // wording here costs no real conversation. There is no session to inspect, so
  // it plans as though the conversation were unassigned.
  const handoff =
    !result.covered && result.needs_human !== false
      ? await planHandoff(c.env, null)
      : null;

  // Whether this answer would actually reach a customer depends on live staffing
  // as well as topic autonomy, so the editor is told both rather than only the
  // half it can work out from topics_used.
  const nobody_online = (await isAnyoneOnline(c.env)) === false;

  return c.json({ ...result, handoff, nobody_online });
});

// The pulse: what came in, what it was about, and how it is trending. Reads
// the metric views rather than the raw tables, so the shape of a number is
// defined once in SQL (0011_conversation_log.sql) and not re-derived here.
//
// Editor-gated like /answer. These are customer conversations, and the view
// definitions deliberately run as the caller — but this endpoint talks to
// Supabase with the service key, so the gate here IS the access control.
app.get("/metrics", async (c) => {
  if (!(await isEditor(c.env, c.req.header("Authorization")))) {
    return c.json({ error: "Not a knowledge base editor" }, 403);
  }

  // Default to four weeks: long enough for a weekly shape to be visible,
  // short enough that the whole response stays small.
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 28), 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const get = async (path: string) => {
    const response = await fetch(`${c.env.SUPABASE_URL}/rest/v1${path}`, {
      headers: {
        apikey: c.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${c.env.SUPABASE_SECRET_KEY}`,
      },
    });
    if (!response.ok) {
      console.error("Metrics query failed:", path, response.status);
      return [];
    }
    return (await response.json()) as unknown[];
  };

  const [daily, tags, responses] = await Promise.all([
    get(`/conversation_daily?day=gte.${since}&order=day.desc`),
    get(`/conversation_tag_daily?day=gte.${since}&order=day.desc,conversations.desc`),
    get(
      `/conversation_first_response?day=gte.${since}&first_response_seconds=gt.0&select=day,first_response_seconds&order=day.desc`
    ),
  ]);

  return c.json({ since, days, daily, tags, first_response: responses });
});

// The help centre's content. Unauthenticated on purpose: this is the same
// material the bot says out loud to anyone who opens a chat, and the portal
// that renders it sits inside a Shopify iframe where our own auth would be a
// second login for no gain. Only enabled Q&As inside enabled topics are ever
// returned, which is the same filter the bot applies.
//
// Cached hard at the edge rather than per-request in memory: the content
// changes a few times a week, and every merchant who opens the help centre
// asks for the identical bytes.
app.get("/kb", async (c) => {
  const topics = await loadPortal(c.env);
  if (!topics) return c.json({ error: "Knowledge base unavailable" }, 502);

  c.header("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=86400");
  return c.json({
    topics,
    counts: {
      topics: topics.length,
      questions: topics.reduce((n, t) => n + t.questions.length, 0),
    },
  });
});

// What the bot already drafted for one conversation, for the Crisp side panel.
//
// Read-only and model-free: it serves a row the muted bot wrote when the
// message came in, or says that none exists. The agent is already reading this
// conversation in Crisp, so this shows them nothing they cannot already see —
// but it is customer data, so unlike /kb it is not public.
app.get("/draft", async (c) => {
  if (!isExtension(c.env, c.req.header("X-Ext-Secret"))) {
    return c.json({ error: "Not authorised" }, 403);
  }

  const sessionId = (c.req.query("session_id") ?? "").trim();
  // Crisp session ids are `session_` plus a uuid. Validated rather than
  // trusted: it is interpolated into a PostgREST filter, where an unchecked
  // value is filter injection and not merely a failed lookup.
  if (!/^session_[0-9a-f-]{8,64}$/i.test(sessionId)) {
    return c.json({ error: "A valid session_id is required" }, 400);
  }

  const result = await loadDraft(c.env, sessionId);
  if (!result) return c.json({ error: "Draft lookup failed" }, 502);

  // No caching: the panel re-reads on every conversation switch, and a draft
  // appears a second or two after the customer's message lands.
  c.header("Cache-Control", "no-store");
  return c.json(result);
});

// Crisp wants a response in under a second, and answering takes several. So
// verify, acknowledge, and do the work after the response has gone out.
app.post("/crisp/webhook", async (c) => {
  const raw = await c.req.text();
  const ok = await verifySignature(
    c.env.CRISP_WEBHOOK_SECRET,
    c.req.header("X-Crisp-Request-Timestamp"),
    raw,
    c.req.header("X-Crisp-Signature")
  );

  if (!ok) {
    console.error("Rejected a Crisp webhook with a bad or missing signature");
    return c.json({ error: "Bad signature" }, 401);
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "Bad JSON" }, 400);
  }

  c.executionCtx.waitUntil(
    handleCrispMessage(c.env, body).catch((e) =>
      console.error("Webhook handling failed:", e)
    )
  );

  return c.json({ received: true });
});

// The server (src/server.ts) supplies the env and execution context and owns
// the schedule; this module stays a plain Hono app so it can be mounted by any
// runtime, and so tests can call app.fetch directly.
export default app;
