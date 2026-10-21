import { Hono } from "hono";
import { cors } from "hono/cors";
import { dailySummary } from "./crons/daily-summary";
import { answerQuestion } from "./answer";
import { handleCrispMessage, BOT_ENABLED } from "./webhook";
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

app.get("/", (c) => {
  return c.json({ message: "Hello from Crisp API!" });
});

// Render pings this to decide whether the instance is healthy. Deliberately
// does no I/O: a health check that talks to Supabase turns someone else's
// outage into our instance being replaced.
// `bot_enabled` is here so you can tell which way the deployed copy has the
// switch set — the first thing you want to check when the bot has gone quiet.
app.get("/health", (c) =>
  c.json({ ok: true, uptime: process.uptime(), bot_enabled: BOT_ENABLED })
);

// Manual trigger for testing
app.get("/test-summary", async (c) => {
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
