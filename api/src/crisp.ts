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
export interface SessionContext {
  apiKey: string | null;
  // The store URL as the admin app recorded it, used ONLY to show the merchant
  // which store we think this is. It never selects the target of an action —
  // tools take no arguments and resolve the store from api_key server-side.
  storeUrl: string | null;
  // Pop Convert's own review gate, pushed into the session alongside api_key.
  // The team's shortcuts already honour it ("User is not qualified or has
  // already reviewed. Don't use shortcuts or ask for review").
  qualification: string | null;
  hasReviewed: boolean | null;
}

export async function getSessionContext(
  env: Env,
  sessionId: string
): Promise<SessionContext> {
  const empty: SessionContext = {
    apiKey: null,
    storeUrl: null,
    qualification: null,
    hasReviewed: null,
  };

  const response = await fetch(
    `https://api.crisp.chat/v1/website/${WEBSITE_ID}/conversation/${sessionId}`,
    { headers: authHeaders(env) }
  );

  if (!response.ok) {
    console.error("Crisp conversation fetch failed:", response.status);
    return empty;
  }

  const json = (await response.json()) as {
    data?: { meta?: { data?: Record<string, unknown> } };
  };
  const data = json.data?.meta?.data ?? {};

  const str = (v: unknown) => (typeof v === "string" && v ? v : null);

  return {
    apiKey: str(data.api_key),
    storeUrl: str(data.url) ?? str(data.user_id),
    qualification: str(data.qualification),
    hasReviewed: typeof data.has_reviewed === "boolean" ? data.has_reviewed : null,
  };
}

// Kept for callers that only need the key.
export async function getSessionApiKey(env: Env, sessionId: string) {
  return (await getSessionContext(env, sessionId)).apiKey;
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
// `mentions` takes operator user_ids and is what actually pushes a notification
// to a person — without it a note is just text nobody is told about.
export async function postNote(
  env: Env,
  sessionId: string,
  text: string,
  mentions: string[] = []
) {
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
        ...(mentions.length ? { mentions } : {}),
      }),
    }
  );

  if (!response.ok) {
    console.error("Crisp note failed:", response.status, await response.text());
    return false;
  }
  return true;
}

// The ONLY customer-visible write in this codebase. Everything else the bot
// says goes out as a note. Today this is called for one thing: telling someone
// their question is being handed to a human. Answers are still notes.
export async function sendMessage(env: Env, sessionId: string, text: string) {
  const response = await fetch(
    `https://api.crisp.chat/v1/website/${WEBSITE_ID}/conversation/${sessionId}/message`,
    {
      method: "POST",
      headers: authHeaders(env),
      body: JSON.stringify({
        type: "text",
        from: "operator",
        origin: "chat",
        content: text,
      }),
    }
  );

  if (!response.ok) {
    console.error("Crisp send failed:", response.status, await response.text());
    return false;
  }
  return true;
}

// Operators who must never be handed a conversation by the bot. Ids rather than
// names because a rename must not silently re-enrol someone:
//   9e1e824b  Jason B        (owner)
//   4c44b612  JP Casabianca
//   ddfc3191  Charmi Celiz
const HANDOFF_EXCLUDED = new Set([
  "9e1e824b-ef60-4cd1-ad94-1637dbc87e93",
  "4c44b612-298c-43f3-b583-edb7b09b2af6",
  "ddfc3191-e044-418f-b10f-12d58fd4e55f",
]);

export function isHandoffEligible(userId: string | null) {
  return Boolean(userId) && !HANDOFF_EXCLUDED.has(userId as string);
}

interface Availability {
  user_id: string;
  type: string;
  time?: { since?: number };
}

// Everyone eligible to receive a handoff, longest-online first. Empty means
// nobody is around, which the caller has to say out loud rather than paper over.
export async function getHandoffCandidates(env: Env) {
  const response = await fetch(
    `https://api.crisp.chat/v1/website/${WEBSITE_ID}/availability/operators`,
    { headers: authHeaders(env) }
  );

  if (!response.ok) {
    console.error("Crisp availability failed:", response.status, await response.text());
    return null;
  }

  const json = (await response.json()) as { data?: Availability[] };
  return (json.data ?? [])
    .filter((o) => o.type === "online" && !HANDOFF_EXCLUDED.has(o.user_id))
    // Longest continuously online first: a stable pick, and the person who has
    // been sitting there a while is likelier to still be there in a minute.
    .sort((a, b) => (a.time?.since ?? 0) - (b.time?.since ?? 0))
    .map((o) => o.user_id);
}

// Is ANY operator present, whether or not they're eligible to be handed work?
// This deliberately ignores HANDOFF_EXCLUDED: the exclusion list says who
// should not be ASSIGNED a conversation, not who is sitting at a desk. Somebody
// excluded can still read a suggested note and send it, so their presence is
// enough to keep the bot from speaking for itself.
//
// Returns null when availability could not be read. Callers must treat that as
// "someone is probably around" — guessing the room is empty is how the bot ends
// up talking to customers over the top of a working agent.
export async function isAnyoneOnline(env: Env): Promise<boolean | null> {
  const response = await fetch(
    `https://api.crisp.chat/v1/website/${WEBSITE_ID}/availability/operators`,
    { headers: authHeaders(env) }
  );

  if (!response.ok) {
    console.error("Crisp availability failed:", response.status);
    return null;
  }

  const json = (await response.json()) as { data?: Availability[] };
  return (json.data ?? []).some((o) => o.type === "online");
}

// Everyone eligible whether or not they're online, for the out-of-hours case
// where the conversation still has to land in somebody's mentions.
export async function getAllHandoffOperators(env: Env) {
  const response = await fetch(
    `https://api.crisp.chat/v1/website/${WEBSITE_ID}/availability/operators`,
    { headers: authHeaders(env) }
  );
  if (!response.ok) return null;
  const json = (await response.json()) as { data?: Availability[] };
  return (json.data ?? [])
    .filter((o) => !HANDOFF_EXCLUDED.has(o.user_id))
    .map((o) => o.user_id);
}

// Module-level so it survives between requests in a warm isolate. The roster
// changes a few times a year; re-fetching it per handoff is pure waste.
const operatorNames = new Map<string, string>();

export async function operatorName(env: Env, userId: string) {
  const cached = operatorNames.get(userId);
  if (cached) return cached;

  const response = await fetch(
    `https://api.crisp.chat/v1/website/${WEBSITE_ID}/operator/${userId}`,
    { headers: authHeaders(env) }
  );
  if (!response.ok) return userId.slice(0, 8);

  const json = (await response.json()) as {
    data?: { first_name?: string; last_name?: string };
  };
  const name = [json.data?.first_name, json.data?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!name) return userId.slice(0, 8);
  operatorNames.set(userId, name);
  return name;
}

// Who owns this conversation already, if anyone. Crisp auto-assigns, so this is
// usually set — and when it is, the bot must not reassign over the top of it.
export async function getAssignee(env: Env, sessionId: string) {
  const response = await fetch(
    `https://api.crisp.chat/v1/website/${WEBSITE_ID}/conversation/${sessionId}/routing`,
    { headers: authHeaders(env) }
  );
  if (!response.ok) {
    console.error("Crisp routing fetch failed:", response.status);
    return null;
  }
  const json = (await response.json()) as { data?: { assigned?: { user_id?: string } } };
  return json.data?.assigned?.user_id ?? null;
}

export async function assignConversation(env: Env, sessionId: string, userId: string) {
  const response = await fetch(
    `https://api.crisp.chat/v1/website/${WEBSITE_ID}/conversation/${sessionId}/routing`,
    {
      method: "PATCH",
      headers: authHeaders(env),
      // Not silent: the point of assigning is that the person finds out.
      body: JSON.stringify({ assigned: { user_id: userId }, silent: false }),
    }
  );

  if (!response.ok) {
    console.error("Crisp assign failed:", response.status, await response.text());
    return false;
  }
  return true;
}
