import { Env } from "./index";

// Every tool takes NO arguments. The store is resolved from the api_key in the
// Crisp session and injected here by the server, so the model can never name a
// target — a prompt-injected "remove the watermark for someone-else.myshopify.com"
// has nowhere to land. This is the single most important property of this file:
// if a tool ever grows a shop/site/store parameter, that guarantee is gone.
export const TOOL_DEFINITIONS = [
  {
    name: "get_account_status",
    description:
      "Look up this merchant's Pop Convert account: their plan, Shopify plan, " +
      "free-period end date, whether the Powered by Pop Convert branding has " +
      "already been removed, how many campaigns they have, and whether email " +
      "features are enabled. Use it whenever the answer depends on their " +
      "specific account rather than on general policy.",
    input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "get_usage_limits",
    description:
      "Look up this merchant's usage against their monthly limits for sessions, " +
      "emails, subscribers, design assets and active campaigns. Use it when they " +
      "ask whether they have hit a limit, how much they have used, or why data " +
      "stopped updating. Returns an empty result for merchants no limits apply to.",
    input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "get_merchant_highlights",
    description:
      "Look up what this merchant has actually achieved with Pop Convert: how " +
      "long they have had the app, how many campaigns they have built and have " +
      "running, total views, clicks and subscribers, attributed revenue, and " +
      "which features they use. Call it before asking for a review, so the ask " +
      "can reference something real. When the result says " +
      "'worth_mentioning': false there is no figure worth quoting, so ask " +
      "without citing any numbers — do not skip the ask.",
    input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "remove_watermark",
    description:
      "Remove the 'Powered by Pop Convert' branding from this merchant's " +
      "campaigns. This performs the change immediately and for free — it is not " +
      "a request or a draft. Call it when the merchant asks for the branding, " +
      "logo or watermark to be removed. Safe to call if it is already removed; " +
      "it will simply report that.",
    input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
];

export interface ToolOutcome {
  name: string;
  result: unknown;
  // True when the call changed something on the merchant's account, so callers
  // can surface it rather than burying it in a suggested reply.
  mutated: boolean;
}

async function pc(env: Env, path: string, apiKey: string, method = "GET") {
  const response = await fetch(
    `${env.PC_BASE_URL}${path}?api_key=${encodeURIComponent(apiKey)}`,
    { method }
  );
  if (!response.ok) {
    console.error(`PC ${path} ${response.status}:`, await response.text());
    return { error: `lookup failed (${response.status})` };
  }
  return await response.json();
}

export async function runTool(
  env: Env,
  name: string,
  apiKey: string | null
): Promise<ToolOutcome> {
  // No resolved store means no tool may run. Without this the model could be
  // talked into acting on an unidentified conversation.
  if (!apiKey) {
    return {
      name,
      mutated: false,
      result: { error: "This conversation is not linked to a store, so account actions are unavailable." },
    };
  }

  switch (name) {
    case "get_account_status":
      return { name, mutated: false, result: await pc(env, "/bot/site_context", apiKey) };

    case "get_usage_limits":
      return { name, mutated: false, result: await pc(env, "/bot/usage_limits", apiKey) };

    case "get_merchant_highlights":
      return { name, mutated: false, result: await merchantHighlights(env, apiKey) };

    case "remove_watermark": {
      const result = (await pc(env, "/bot/remove_watermark", apiKey, "POST")) as Record<string, unknown>;
      // "already_removed" changed nothing, so don't report an action that
      // did not happen.
      return { name, mutated: result?.status === "removed", result };
    }

    default:
      return { name, mutated: false, result: { error: `Unknown tool: ${name}` } };
  }
}

interface ReviewContext {
  installed_at?: string;
  days_installed?: number;
  campaigns?: { total?: number; active?: number; by_goal?: Record<string, number> };
  engagement?: {
    total_views?: number;
    total_clicks?: number;
    total_subscribers?: number;
  };
  revenue?: { attributed_orders?: number; attributed_revenue?: number; currency?: string };
  social_proof?: { enabled?: boolean; active?: number };
  emails?: { enabled?: boolean; by_state?: Record<string, number> };
  flows?: { enabled?: boolean; by_kind?: Record<string, number> };
}

// Whether this merchant has done enough for a NUMBER to be worth quoting back
// at them. Note what this is NOT: a gate on asking for a review at all. The
// extension's ten-day floor exists because it picks review candidates
// proactively, and a day-two merchant is a poor cold target. The bot's moment
// is the opposite — the merchant came to us and we just did something for them
// free — and someone with an empty account can still review the support they
// just received. So time on the app is irrelevant here; only whether there is a
// real figure to cite.
//
// Deliberately generous about what counts. Campaigns built, subscribers
// collected and views earned are all real achievements whether or not anything
// is switched on right now — a merchant who built 256 campaigns over 545 days
// has invested a great deal, and telling them that is not hollow.
function worthMentioning(ctx: ReviewContext) {
  const built = ctx.campaigns?.total ?? 0;
  const subscribers = ctx.engagement?.total_subscribers ?? 0;
  const views = ctx.engagement?.total_views ?? 0;
  const revenue = ctx.revenue?.attributed_revenue ?? 0;
  const sentEmails = ctx.emails?.by_state?.sent ?? 0;

  // Each threshold is set where a merchant would actually feel the number
  // rather than merely recognise it. "You have 2 running campaigns" is true,
  // unimpressive, and makes for a clumsy sentence; 2,000 subscribers is a
  // different kind of fact. Having SOME campaign running is not on this list on
  // purpose — it gates nothing, since the ask happens regardless.
  return (
    built >= 10 ||
    subscribers >= 25 ||
    views >= 1000 ||
    revenue > 0 ||
    sentEmails > 0 ||
    (ctx.social_proof?.active ?? 0) > 0
  );
}

async function merchantHighlights(env: Env, apiKey: string) {
  // Keyed on api_key, not on a store name the model could supply. Same
  // invariant as every other tool here.
  const response = await fetch(
    `${env.PC_BASE_URL}/micro/api/sites/review_context?api_key=${encodeURIComponent(apiKey)}`
  );

  if (!response.ok) {
    console.error("review_context failed:", response.status, await response.text());
    return { error: `highlights lookup failed (${response.status})`, worth_mentioning: false };
  }

  const ctx = (await response.json()) as ReviewContext;

  // Only the facts a chat message could plausibly use, so the model is not
  // picking a stat out of eighty fields. Zeroes are dropped rather than sent as
  // zero: a number that is absent cannot be quoted proudly.
  const facts: Record<string, unknown> = {};
  const keep = (key: string, value: number | undefined, min = 1) => {
    if (typeof value === "number" && value >= min) facts[key] = value;
  };

  // Only once it is a span worth remarking on: "you've been with us 3 days" is
  // not a compliment.
  keep("days_installed", ctx.days_installed, 10);
  keep("campaigns_built", ctx.campaigns?.total);
  keep("campaigns_running", ctx.campaigns?.active);
  keep("subscribers_collected", ctx.engagement?.total_subscribers);
  keep("popup_views", ctx.engagement?.total_views);
  keep("emails_sent", ctx.emails?.by_state?.sent);

  if ((ctx.revenue?.attributed_revenue ?? 0) > 0) {
    facts.attributed_revenue = ctx.revenue?.attributed_revenue;
    facts.currency = ctx.revenue?.currency;
  }
  if ((ctx.social_proof?.active ?? 0) > 0) facts.social_proof_running = true;
  if (ctx.flows?.enabled) facts.automations = Object.keys(ctx.flows.by_kind ?? {});

  return {
    // Governs only whether a number may be quoted, never whether to ask. Decided
    // here rather than by the model, because "is this impressive" is exactly the
    // judgement a model talks itself into.
    worth_mentioning: worthMentioning(ctx),
    ...facts,
  };
}
