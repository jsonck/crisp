import { Env } from "./index";

// Only the fields Pop Convert's bot context endpoint returns. Everything here is
// read from the site record server-side; the api_key only selects which site.
export interface SiteContext {
  site_name?: string;
  source?: string;
  plan?: string;
  shop_plan?: string;
  currency?: string;
  price?: number | null;
  installed_on?: string;
  free_until?: string | null;
  watermark_removed?: boolean;
  emails_enabled?: boolean;
  active_campaigns?: number;
  total_campaigns?: number;
  has_reviewed?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fetchSiteContext(env: Env, apiKey: string | null) {
  if (!apiKey || !UUID.test(apiKey)) return null;
  if (!env.PC_BASE_URL) {
    console.error("Site context not configured (PC_BASE_URL)");
    return null;
  }

  try {
    const response = await fetch(
      `${env.PC_BASE_URL}/bot/site_context?api_key=${encodeURIComponent(apiKey)}`
    );

    if (!response.ok) {
      console.error("site_context failed:", response.status, await response.text());
      return null;
    }
    return (await response.json()) as SiteContext;
  } catch (e) {
    console.error("site_context error:", e);
    return null;
  }
}

function days(from: string | null | undefined) {
  if (!from) return null;
  const ms = new Date(from).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86400000)) : null;
}

// The few facts cheap enough to put in front of the model on every message, so
// a pricing or trial question answers in one round trip instead of two. Anything
// deeper — campaign counts, usage, limits — is a tool the model asks for, which
// also means a tool result carries standing that ambient context does not.
export function renderSiteContext(ctx: SiteContext) {
  const lines: string[] = [];
  if (ctx.shop_plan) lines.push(`Shopify plan: ${ctx.shop_plan}`);

  const left = days(ctx.free_until);
  if (left !== null) {
    lines.push(left > 0 ? `Free period ends in ${left} day(s)` : "Free period has ended");
  }

  if (typeof ctx.watermark_removed === "boolean") {
    lines.push(
      ctx.watermark_removed
        ? "Branding/watermark: already removed"
        : "Branding/watermark: still showing"
    );
  }

  return lines.join("\n");
}
