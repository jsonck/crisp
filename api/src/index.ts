import { Hono } from "hono";
import { cors } from "hono/cors";
import { dailySummary } from "./crons/daily-summary";

export interface Env {
  CRISP_KEY: string;
  ANTHROPIC_API_KEY: string;
  MAILGUN_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/", (c) => {
  return c.json({ message: "Hello from Crisp API!" });
});

// Manual trigger for testing
app.get("/test-summary", async (c) => {
  await dailySummary(c.env);
  return c.json({ message: "Summary sent!" });
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dailySummary(env));
  },
};
