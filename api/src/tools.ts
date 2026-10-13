import { Env } from "./index";

// Every tool takes NO arguments. The store is resolved from the api_key in the
// Crisp session and injected here by the worker, so the model can never name a
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
