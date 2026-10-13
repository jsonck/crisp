import { Hono } from "hono";
import { cors } from "hono/cors";
import { dailySummary } from "./crons/daily-summary";
import { answerQuestion } from "./answer";
import { handleCrispMessage } from "./webhook";
import { verifySignature } from "./crisp";

export interface Env {
  CRISP_KEY: string;
  ANTHROPIC_API_KEY: string;
  MAILGUN_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  CRISP_WEBHOOK_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

// Answering burns Anthropic tokens, and this worker is on a public URL, so the
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

  const result = await answerQuestion(c.env, question, body?.history ?? []);
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

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dailySummary(env));
  },
};
