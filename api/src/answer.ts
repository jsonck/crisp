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
  answer: string;
  topics_used: string[];
  reason?: string;
  // Diagnostics, so the editor can show whether caching is actually working.
  usage?: { cached: number; written: number; input: number; output: number };
}

const NOT_COVERED: Answer = {
  covered: false,
  answer: "",
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
      answer: "",
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
    // A malformed "covered: true" with no answer would post an empty reply to
    // a customer, so treat it as not covered.
    if (parsed.covered && !parsed.answer?.trim()) {
      return { covered: false, answer: "", topics_used: [], reason: "Empty answer.", usage };
    }
    return { ...parsed, usage };
  } catch {
    console.error("Unparseable answer. stop_reason:", json.stop_reason, "text:", text.slice(0, 300));
    return { ...NOT_COVERED, reason: "The answering service returned an unreadable response.", usage };
  }
}
