// The branding-removal script's memory. See 0006_watermark_flow.sql for why a
// transcript alone is not enough.

import { Env } from "./index";

export interface FlowState {
  // Have we already shown them a store URL and asked them to confirm it?
  askedConfirm: boolean;
  // Did WE remove the branding during this conversation? Distinct from the
  // account-level "already removed", which may predate the conversation.
  removed: boolean;
  // Have we already asked for a review here? Guards against asking twice.
  reviewAsked: boolean;
  // Is this merchant eligible to be asked at all? Pop Convert's own gate:
  // Qualifier.qualify returns 'mango' only for a real plan that has not already
  // reviewed. Every other value is a random colour meaning "do not ask".
  reviewAllowed: boolean;
  // What we told them their store URL is, for the confirmation step.
  storeUrl: string | null;
}

export const EMPTY_FLOW: FlowState = {
  askedConfirm: false,
  removed: false,
  reviewAsked: false,
  reviewAllowed: false,
  storeUrl: null,
};

async function rest(env: Env, path: string, init: RequestInit & { prefer?: string } = {}) {
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
    return null;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function loadFlow(
  env: Env,
  sessionId: string,
  qualification: string | null
): Promise<FlowState> {
  const reviewAllowed = qualification === "mango";

  const rows = await rest(
    env,
    `/watermark_flows?session_id=eq.${sessionId}&select=store_url,asked_confirm_at,removed_at,review_asked_at&limit=1`
  );

  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!row) return { ...EMPTY_FLOW, reviewAllowed };

  return {
    askedConfirm: Boolean(row.asked_confirm_at),
    removed: Boolean(row.removed_at),
    reviewAsked: Boolean(row.review_asked_at),
    reviewAllowed,
    storeUrl: row.store_url ?? null,
  };
}

// Upserts only the transitions that just happened. Timestamps are never
// cleared, so the flow can move forward but not silently backwards.
export async function recordFlow(
  env: Env,
  sessionId: string,
  websiteId: string,
  patch: {
    storeUrl?: string | null;
    askedConfirm?: boolean;
    removed?: boolean;
    reviewAsked?: boolean;
  }
) {
  const now = new Date().toISOString();
  const body: Record<string, unknown> = {
    session_id: sessionId,
    website_id: websiteId,
    updated_at: now,
  };

  if (patch.storeUrl !== undefined) body.store_url = patch.storeUrl;
  if (patch.askedConfirm) body.asked_confirm_at = now;
  if (patch.removed) body.removed_at = now;
  if (patch.reviewAsked) body.review_asked_at = now;

  // merge-duplicates makes this an upsert; the columns absent from `body` keep
  // whatever they already held.
  await rest(env, "/watermark_flows", {
    method: "POST",
    prefer: "resolution=merge-duplicates",
    body: JSON.stringify(body),
  });
}

// The facts the model needs, in the order it needs them. Placed after the cache
// breakpoint because it changes every message.
export function renderFlow(flow: FlowState) {
  const lines: string[] = [];

  if (flow.storeUrl) lines.push(`Their store URL: ${flow.storeUrl}`);
  if (flow.askedConfirm)
    lines.push("You have ALREADY asked them to confirm their store URL in this conversation.");
  if (flow.removed)
    lines.push("You have ALREADY removed the branding in this conversation. Do not call the tool again.");

  if (flow.reviewAsked) {
    lines.push("You have ALREADY asked for a review here. Do not ask again.");
  } else if (!flow.reviewAllowed) {
    lines.push("Do NOT ask this merchant for a review — they are not eligible.");
  } else if (flow.removed) {
    lines.push("You may ask for a review now, once, in this reply.");
  } else {
    // The ask has to be able to ride along in the same reply that performs the
    // removal, or it strands: if it had to wait for the following turn, a
    // merchant who says nothing after "it's done" would never be asked at all.
    lines.push(
      "You may ask for a review once, but only in a message that comes AFTER " +
        "you have told them the branding is off. Same reply is fine as a second " +
        "message; never before the removal, and never if the removal did not happen."
    );
  }

  return lines.join("\n");
}
