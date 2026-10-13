import { Env } from "./index";

export const CRISP_IDENTIFIER = "012fbb8d-c0a4-45df-a7f1-33b976790cd0";
export const WEBSITE_ID = "293e3fde-cb94-4151-b17c-33ddbb80ca09";

export interface CrispMessage {
  type: string;
  from: string;
  content: any;
  timestamp: number;
  fingerprint?: number;
  user?: { nickname?: string };
}

function authHeaders(env: Env) {
  return {
    Authorization: "Basic " + btoa(`${CRISP_IDENTIFIER}:${env.CRISP_KEY}`),
    "X-Crisp-Tier": "plugin",
    "Content-Type": "application/json",
  };
}

// Plugin hooks are signed as HMAC-SHA256 over the literal string
// `[<timestamp>;<raw body>]` — brackets and semicolon included — so the raw
// body text has to be used here, never a re-serialised JSON object.
export async function verifySignature(
  secret: string,
  timestamp: string | undefined,
  rawBody: string,
  signature: string | undefined
) {
  if (!secret || !timestamp || !signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`[${timestamp};${rawBody}]`)
  );
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time compare, so a wrong signature can't be narrowed down by
  // timing how long the rejection took.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// The admin app pushes the site's api_key into Crisp session data. It is an
// unguessable uuid that only the authenticated Shopify admin ever receives, so
// it is the one field here worth trusting to say which store this is.
export async function getSessionApiKey(env: Env, sessionId: string) {
  const response = await fetch(
    `https://api.crisp.chat/v1/website/${WEBSITE_ID}/conversation/${sessionId}`,
    { headers: authHeaders(env) }
  );

  if (!response.ok) {
    console.error("Crisp conversation fetch failed:", response.status);
    return null;
  }

  const json = (await response.json()) as { data?: { meta?: { data?: Record<string, unknown> } } };
  const key = json.data?.meta?.data?.api_key;
  return typeof key === "string" && key ? key : null;
}

export async function getRecentMessages(env: Env, sessionId: string) {
  const response = await fetch(
    `https://api.crisp.chat/v1/website/${WEBSITE_ID}/conversation/${sessionId}/messages`,
    { headers: authHeaders(env) }
  );

  if (!response.ok) {
    console.error("Crisp messages fetch failed:", response.status, await response.text());
    return null;
  }
  const json = (await response.json()) as { data: CrispMessage[] };
  return json.data ?? [];
}

// `type: "note"` is operator-only: it lands in the conversation for the team
// but is never delivered to the customer.
export async function postNote(env: Env, sessionId: string, text: string) {
  const response = await fetch(
    `https://api.crisp.chat/v1/website/${WEBSITE_ID}/conversation/${sessionId}/message`,
    {
      method: "POST",
      headers: authHeaders(env),
      body: JSON.stringify({
        type: "note",
        from: "operator",
        origin: "chat",
        content: text,
      }),
    }
  );

  if (!response.ok) {
    console.error("Crisp note failed:", response.status, await response.text());
    return false;
  }
  return true;
}
