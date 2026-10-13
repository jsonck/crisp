import { Env } from "./index";
import {
  loadKnowledgeBase,
  renderKnowledgeBase,
  explainEmpty,
  SYSTEM_INSTRUCTIONS,
  OUTPUT_FORMAT,
} from "./kb";

export interface Answer {
  covered: boolean;
  // One chat message per entry, the way a person types in a live chat rather
  // than one considered paragraph. Usually length 1.
  messages: string[];
  topics_used: string[];
  reason?: string;
  // Diagnostics, so the editor can show whether caching is actually working.
  usage?: { cached: number; written: number; input: number; output: number };
}

const NOT_COVERED: Answer = {
  covered: false,
  messages: [],
  topics_used: [],
  reason: "The knowledge base could not be loaded.",
};

export async function answerQuestion(
  env: Env,
  question: string,
  history: { role: "user" | "assistant"; content: string }[] = []
): Promise<Answer> {
  const kb = await loadKnowledgeBase(env);
  if (!kb) return NOT_COVERED;

  const rendered = renderKnowledgeBase(kb.topics, kb.qaPairs);
  if (!rendered) {
    return {
      covered: false,
      messages: [],
      topics_used: [],
      reason: explainEmpty(kb.allTopics, kb.allQaPairs),
    };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 1024,
      output_config: { effort: "low" },
      // Stable prefix first, cached; the customer's question is the only
      // thing that varies per request.
      system: [
        {
          type: "text",
          text: `${SYSTEM_INSTRUCTIONS}\n\n# Knowledge base\n\n${rendered}\n\n${OUTPUT_FORMAT}`,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [...history, { role: "user", content: question }],
    }),
  });

  if (!response.ok) {
    console.error("Anthropic error:", await response.text());
    return { ...NOT_COVERED, reason: "The answering service returned an error." };
  }

  const json = (await response.json()) as {
    content: { type: string; text?: string }[];
    stop_reason?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };

  const text = json.content?.find((b) => b.type === "text")?.text ?? "";
  const usage = {
    cached: json.usage?.cache_read_input_tokens ?? 0,
    written: json.usage?.cache_creation_input_tokens ?? 0,
    input: json.usage?.input_tokens ?? 0,
    output: json.usage?.output_tokens ?? 0,
  };

  if (json.stop_reason === "refusal") {
    return { ...NOT_COVERED, reason: "The answering service declined this request.", usage };
  }

  try {
    const parsed = JSON.parse(text) as Answer;

    // Tolerate the model returning a bare string instead of an array.
    const raw = Array.isArray(parsed.messages)
      ? parsed.messages
      : typeof (parsed as any).messages === "string"
        ? [(parsed as any).messages]
        : typeof (parsed as any).answer === "string"
          ? [(parsed as any).answer]
          : [];

    // Drop blanks, and cap at 3 so a runaway response can't turn into a
    // barrage of chat messages at the customer.
    const messages = raw
      .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      .map((m) => m.trim())
      .slice(0, 3);

    // A malformed "covered: true" with nothing to say would post an empty
    // reply, so treat it as not covered.
    if (parsed.covered && !messages.length) {
      return { covered: false, messages: [], topics_used: [], reason: "Empty answer.", usage };
    }
    return { ...parsed, messages, usage };
  } catch {
    console.error("Unparseable answer. stop_reason:", json.stop_reason, "text:", text.slice(0, 300));
    return { ...NOT_COVERED, reason: "The answering service returned an unreadable response.", usage };
  }
}
