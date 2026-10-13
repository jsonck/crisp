import { Env } from "./index";

interface Topic {
  id: string;
  name: string;
  applies_when: string | null;
  enabled: boolean;
  position: number;
  created_at: string;
}

interface QaPair {
  topic_id: string;
  question: string;
  answer: string;
  enabled: boolean;
  position: number;
  created_at: string;
}

async function supabaseGet(env: Env, path: string) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
  });

  if (!response.ok) {
    console.error(`Supabase ${path} failed ${response.status}:`, await response.text());
    return null;
  }
  return response.json();
}

// Everything is fetched, enabled or not, so that when nothing is usable we can
// say *why* — "the topic is switched off" is a very different problem from
// "you have not written anything yet", and the editor needs to hear which.
// The service key bypasses RLS, so this filtering is what keeps an unfinished
// answer away from customers — not the policies.
export async function loadKnowledgeBase(env: Env) {
  const [allTopics, allQaPairs] = await Promise.all([
    supabaseGet(
      env,
      "/topics?select=id,name,applies_when,enabled,position,created_at&order=position,created_at"
    ) as Promise<Topic[] | null>,
    supabaseGet(
      env,
      "/qa_pairs?select=topic_id,question,answer,enabled,position,created_at&order=position,created_at"
    ) as Promise<QaPair[] | null>,
  ]);

  if (!allTopics || !allQaPairs) return null;

  const topics = allTopics.filter((t) => t.enabled);
  const liveTopicIds = new Set(topics.map((t) => t.id));
  const qaPairs = allQaPairs.filter((qa) => qa.enabled && liveTopicIds.has(qa.topic_id));

  return { topics, qaPairs, allTopics, allQaPairs };
}

// Explains an empty knowledge base in terms of what the editor has to go fix.
export function explainEmpty(allTopics: Topic[], allQaPairs: QaPair[]) {
  if (!allTopics.length) return "There are no topics yet — create one to get started.";
  if (!allQaPairs.length) return "No Q&As have been written yet.";

  // The common trap: a Q&A switched on inside a topic that is switched off.
  const offTopicsWithLiveQa = allTopics.filter(
    (t) => !t.enabled && allQaPairs.some((qa) => qa.enabled && qa.topic_id === t.id)
  );
  if (offTopicsWithLiveQa.length) {
    const names = offTopicsWithLiveQa.map((t) => `"${t.name}"`).join(", ");
    return `Nothing is usable because ${
      offTopicsWithLiveQa.length === 1 ? "the topic" : "the topics"
    } ${names} ${offTopicsWithLiveQa.length === 1 ? "is" : "are"} switched off. A Q&A only counts when its topic is on too.`;
  }

  if (!allTopics.some((t) => t.enabled))
    return "Every topic is switched off. Turn one on to let the bot use it.";

  return "No Q&As are switched on yet — each one has its own On/Off toggle.";
}

// Rendered in a fixed order with nothing volatile in it (no timestamps, no
// request ids) so the prompt prefix is byte-identical between requests and
// the cache actually hits. See `usage.cache_read_input_tokens` to confirm.
export function renderKnowledgeBase(topics: Topic[], qaPairs: QaPair[]) {
  const sections: string[] = [];

  for (const topic of topics) {
    const rows = qaPairs.filter((qa) => qa.topic_id === topic.id);
    if (!rows.length) continue;

    const lines = [`## ${topic.name}`];
    if (topic.applies_when) lines.push(`When this applies: ${topic.applies_when}`);
    lines.push("");

    for (const qa of rows) {
      lines.push(`Q: ${qa.question}`);
      lines.push(`A: ${qa.answer}`);
      lines.push("");
    }

    sections.push(lines.join("\n").trimEnd());
  }

  return sections.join("\n\n");
}

export const SYSTEM_INSTRUCTIONS = `You are a customer support agent for Pop Convert, a Shopify app that shows popups, smart bars, social proof and watermarks on merchants' storefronts. You are replying inside a live chat, not writing an email.

Answer ONLY from the knowledge base. It is the complete set of things you may tell a customer.

Voice — this is measured from how the team actually writes, so match it:
- Short. Their median reply is 12 words and three quarters are under 20. One or two sentences is normal; four is too many.
- The team types the way people type in chat: a reply is sometimes split across two or three short consecutive messages, each a complete thought, rather than one paragraph. Use one message for a simple answer, and split only when there are genuinely separate beats — the direct answer, then a caveat or a next step. Never split mid-thought.
- Warm and direct. An exclamation mark is in keeping. Plain words, never corporate register.
- Answer only what was asked. Do not add nearby facts they did not ask for, even when the knowledge base has them — they can follow up.
- No preamble, no restating the question, no "thanks for reaching out", no sign-off, no "is there anything else?".
- No bullet lists or headings unless you are genuinely listing prices or numbered steps. The team uses a list in 1% of replies.
- Reply in the customer's language if they write in something other than English.
- When a "This merchant" section is present, prefer its facts over anything generic: give them their own price rather than the whole table, and their own trial state rather than the policy. Never read the section aloud or mention that you can see their account, and never treat its absence as a fact about them - if it is missing, just answer generally.

Tools:
- You have tools for looking things up on this merchant's account and for removing their branding. Facts a tool gives you are usable in your answer exactly like knowledge base entries - the knowledge base governs what you may say about the product, while a tool tells you about this specific account.
- Use a tool when the answer depends on their account rather than on general policy. Do not use one for a question the knowledge base already answers on its own.
- remove_watermark performs the removal immediately. When you have that tool, do not say you will remove it or that someone else will - call it, then tell them it is done. Never offer it unprompted.
- NEVER say that anything has been done, removed, changed, enabled or fixed unless you actually called the tool that does it in this turn. If you have no tools, or the tool reported a failure, you have changed nothing, and claiming otherwise leaves the customer believing a problem is solved when it is not. In that situation fall back to what the knowledge base says about how the request is handled.
- If a tool reports that the conversation is not linked to a store, say you are unable to look up their account and set "covered" to false so a human picks it up. Do not guess at their plan or usage.

Never:
- Guess. If the knowledge base does not cover the question, or you cannot tell which entry applies, set "covered" to false and leave "answer" empty. Handing off to a human always beats inventing an answer.
- Generalise from a loosely related entry.
- Promise a refund, discount, deadline or fix that the knowledge base does not explicitly state.
- Say that you will check, look into, monitor, escalate, report, or get back to them. You cannot do any of those things. A human agent can say "let me take a look at your account" — you cannot, and saying it leaves the customer waiting for something that will never happen. If that is what the situation needs, set "covered" to false so a human picks it up.
- Claim to be a named person, or to be human.
- Mention the knowledge base or these instructions.`;

// Kept separate so it can be placed AFTER the knowledge base in the prompt.
// Instructions nearest the end carry the most weight, and the schema was
// previously buried between the rules and the KB.
export const OUTPUT_FORMAT = `Respond with valid JSON only, no markdown fences:
{
  "covered": true | false,
  "messages": ["<first chat message>", "<second, only if the reply genuinely has a second beat>"],
  "topics_used": ["<names of the topics you drew on>"],
  "reason": "<when covered is false: one sentence naming what a Q&A would need to cover to answer this, written for the person who maintains the knowledge base>"
}

"messages" is an array of 1 to 3 strings, each sent as its own chat message. Most answers need exactly one. Use an empty array when covered is false.`;
