const BASE_URL = "/crisp-api/v1";
const IDENTIFIER = "012fbb8d-c0a4-45df-a7f1-33b976790cd0";
const WEBSITE_ID = "293e3fde-cb94-4151-b17c-33ddbb80ca09";
const KEY = import.meta.env.VITE_CRISP_KEY as string;

const headers: HeadersInit = {
  Authorization: "Basic " + btoa(`${IDENTIFIER}:${KEY}`),
  "X-Crisp-Tier": "plugin",
};

async function get(path: string, query: Record<string, string> = {}) {
  const params = new URLSearchParams(query).toString();
  const url = `${BASE_URL}${path}${params ? `?${params}` : ""}`;

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Crisp API error ${response.status}:`, body);
    return null;
  }

  const json = await response.json();
  return json.data;
}

export async function listConversations(page = 1) {
  return get(`/website/${WEBSITE_ID}/conversations/${page}`);
}

export async function getConversation(sessionId: string) {
  return get(`/website/${WEBSITE_ID}/conversation/${sessionId}`);
}

export async function getMessages(
  sessionId: string,
  timestampBefore?: number
) {
  const query: Record<string, string> = {};
  if (timestampBefore) query.timestamp_before = String(timestampBefore);
  return get(
    `/website/${WEBSITE_ID}/conversation/${sessionId}/messages`,
    query
  );
}

export async function getAllMessages(sessionId: string) {
  let allMessages: any[] = [];
  let timestampBefore: number | undefined;

  while (true) {
    const batch = await getMessages(sessionId, timestampBefore);
    if (!Array.isArray(batch) || batch.length === 0) break;

    allMessages = [...batch, ...allMessages];
    if (batch.length < 20) break;

    timestampBefore = batch[0].timestamp;
  }

  return allMessages;
}

export async function fullConversation(sessionId: string) {
  const [meta, messages] = await Promise.all([
    getConversation(sessionId),
    getAllMessages(sessionId),
  ]);
  return { meta, messages };
}
