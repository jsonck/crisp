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
  if (!env.PC_BASE_URL || !env.BOT_API_SECRET) {
    console.error("Site context not configured (PC_BASE_URL / BOT_API_SECRET)");
    return null;
  }

  try {
    const response = await fetch(
      `${env.PC_BASE_URL}/bot/site_context?api_key=${encodeURIComponent(apiKey)}`,
      { headers: { Authorization: `Bearer ${env.BOT_API_SECRET}` } }
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

// Rendered for the model as plain facts. Deliberately terse: this is appended
// after the cached prefix, so every token here is billed on every message.
export function renderSiteContext(ctx: SiteContext) {
  const lines: string[] = [];
  if (ctx.site_name) lines.push(`Store: ${ctx.site_name}`);
  if (ctx.shop_plan) lines.push(`Shopify plan: ${ctx.shop_plan}`);
  if (ctx.plan) lines.push(`Pop Convert plan: ${ctx.plan}`);
  if (ctx.currency) lines.push(`Currency: ${ctx.currency}`);

  const left = days(ctx.free_until);
  if (left !== null) {
    lines.push(left > 0 ? `Free period ends in ${left} day(s)` : "Free period has ended");
  }

  if (typeof ctx.watermark_removed === "boolean") {
    lines.push(
      ctx.watermark_removed
        ? "Branding/watermark: already removed on this account"
        : "Branding/watermark: still showing on this account"
    );
  }
  if (typeof ctx.active_campaigns === "number") {
    lines.push(`Campaigns: ${ctx.active_campaigns} active of ${ctx.total_campaigns ?? ctx.active_campaigns}`);
  }
  if (ctx.emails_enabled === false) lines.push("Email features: not enabled on this account");

  return lines.join("\n");
}
