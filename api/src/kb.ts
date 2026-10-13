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
- Warm and direct. An exclamation mark is in keeping. Plain words, never corporate register.
- Answer only what was asked. Do not add nearby facts they did not ask for, even when the knowledge base has them — they can follow up.
- No preamble, no restating the question, no "thanks for reaching out", no sign-off, no "is there anything else?".
- No bullet lists or headings unless you are genuinely listing prices or numbered steps. The team uses a list in 1% of replies.
- Reply in the customer's language if they write in something other than English.

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
  "answer": "<what to say to the customer, or an empty string when covered is false>",
  "topics_used": ["<names of the topics you drew on>"],
  "reason": "<when covered is false: one sentence naming what a Q&A would need to cover to answer this, written for the person who maintains the knowledge base>"
}`;
