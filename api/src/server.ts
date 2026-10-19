// Node entry point. Everything below this file is platform-agnostic: the
// modules take an `Env` and use plain fetch, so the only Cloudflare-specific
// things were the entry point and the cron trigger, both replaced here.
//
// Hono's app.fetch(request, env, ctx) takes the environment and execution
// context explicitly, which is why nothing inside the handlers had to change —
// `c.env` and `c.executionCtx.waitUntil` work exactly as they did on Workers.

import { serve } from "@hono/node-server";
import cron from "node-cron";
import app, { type Env } from "./index";
import { dailySummary } from "./crons/daily-summary";

function required(name: keyof Env): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

// Read once at boot and fail loudly. A half-configured process that starts and
// then 500s on every webhook is worse than one that refuses to start.
const env: Env = {
  CRISP_KEY: required("CRISP_KEY"),
  ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY"),
  SUPABASE_URL: required("SUPABASE_URL"),
  SUPABASE_SECRET_KEY: required("SUPABASE_SECRET_KEY"),
  CRISP_WEBHOOK_SECRET: required("CRISP_WEBHOOK_SECRET"),
  PC_BASE_URL: required("PC_BASE_URL"),
  // Only the daily summary needs this, so a missing value should not stop the
  // webhook from being served.
  MAILGUN_KEY: process.env.MAILGUN_KEY ?? "",
};

// Stands in for the Workers ExecutionContext. The webhook route acknowledges
// Crisp immediately and finishes the work after responding; on Workers that
// needed waitUntil to keep the isolate alive, and here the process is alive
// anyway — but the shape is kept so the route code is unchanged.
//
// The caveat is the same as it was on Workers: work in flight when the process
// dies is lost. The fingerprint is claimed before the model is called, so a
// Crisp retry would be treated as a duplicate rather than re-answered. That
// was true of the Worker too; it is not a regression, and the fix (a real
// queue) is the same on either platform.
const executionCtx = {
  // Hono types this slot as a Workers ExecutionContext, which carries a `props`
  // field we have no equivalent for. Only waitUntil is ever called.
  props: {},
  waitUntil(promise: Promise<unknown>) {
    Promise.resolve(promise).catch((e) =>
      console.error("Background task failed:", e)
    );
  },
  passThroughOnException() {},
};

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: (request: Request) => app.fetch(request, env, executionCtx), port }, (info) => {
  console.log(`crisp-api listening on :${info.port}`);
});

// Replaces the wrangler [triggers] cron. Same expression, same UTC basis —
// node-cron defaults to the system timezone, so it is pinned explicitly.
cron.schedule(
  "0 10 * * *",
  () => {
    console.log("Running daily summary");
    dailySummary(env).catch((e) => console.error("Daily summary failed:", e));
  },
  { timezone: "UTC" }
);

// Render replaces instances rather than restarting them, so a clean exit on
// SIGTERM keeps a deploy from cutting an in-flight answer short.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    process.exit(0);
  });
}
