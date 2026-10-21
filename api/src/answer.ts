import { Env } from "./index";
import {
  loadKnowledgeBase,
  renderKnowledgeBase,
  explainEmpty,
  SYSTEM_INSTRUCTIONS,
  OUTPUT_FORMAT,
} from "./kb";
import { renderSiteContext, type SiteContext } from "./site";
import { renderFlow, type FlowState } from "./flow";
import { TOOL_DEFINITIONS, runTool, type ToolOutcome } from "./tools";

export interface Answer {
  covered: boolean;
  // True when every topic this answer drew on is marked autonomous, so the
  // reply may be sent to the customer rather than posted as a note. Computed
  // here, from the loaded knowledge base — never taken from the model.
  sendable?: boolean;
  // Step markers for the branding-removal script, reported by the model rather
  // than guessed from the text: one asks the merchant to confirm their store,
  // the other asks for a review. Both drive what the next message may do.
  asked_to_confirm?: boolean;
  asked_for_review?: boolean;
  // Whether a person is actually waiting on this. False for newsletters, spam
  // and automated noise, which must not be routed to an operator. Absent is
  // read as true: failing toward a human is the safe direction.
  needs_human?: boolean;
  // Tools the model actually called, and whether any of them changed the
  // merchant's account. Surfaced so a completed action is never buried inside
  // a reply that reads like a suggestion.
  tools_used?: string[];
  actions_taken?: string[];
  // Mutating tools the model called while muted, and so was refused. Lives
  // beside actions_taken rather than in it: that list means "really happened".
  withheld_actions?: string[];
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
  needs_human: true,
  messages: [],
  topics_used: [],
  reason: "The knowledge base could not be loaded.",
};

export async function answerQuestion(
  env: Env,
  question: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
  siteContext: SiteContext | null = null,
  apiKey: string | null = null,
  flow: FlowState | null = null,
  // Muted mode: lookups still run, account changes are refused. Nothing else
  // about the call changes — same prompt, same tools offered — because a draft
  // produced under a different prompt would not be the draft the bot would
  // really have written, and watching that draft is the point of muting.
  muted = false
): Promise<Answer> {
  const kb = await loadKnowledgeBase(env);
  if (!kb) return NOT_COVERED;

  const rendered = renderKnowledgeBase(kb.topics, kb.qaPairs);
  if (!rendered) {
    return {
      covered: false,
      needs_human: true,
      messages: [],
      topics_used: [],
      reason: explainEmpty(kb.allTopics, kb.allQaPairs),
    };
  }

  const contextBlock = siteContext ? renderSiteContext(siteContext) : "";

  const messages: any[] = [...history, { role: "user", content: question }];
  const system = [
    {
      type: "text",
      text: `${SYSTEM_INSTRUCTIONS}\n\n# Knowledge base\n\n${rendered}\n\n${OUTPUT_FORMAT}`,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
    // Per-merchant facts go AFTER the cache breakpoint. They change every
    // conversation, so caching them would invalidate the knowledge base
    // prefix on every single message.
    ...(contextBlock
      ? [{ type: "text" as const, text: `# This merchant\n\n${contextBlock}` }]
      : []),
    // Where the branding-removal script is up to. Also after the breakpoint:
    // it changes on every message by design.
    ...(flow && renderFlow(flow)
      ? [{ type: "text" as const, text: `# This conversation\n\n${renderFlow(flow)}` }]
      : []),
    // Say the quiet part explicitly. Without this the model has a knowledge base
    // entry about removing the watermark, an instruction not to promise someone
    // else will do it, and no tool - and resolves that by claiming it is already
    // done. Observed in testing: "Done - the watermark is off your account!"
    // on a conversation with no store linked and no tool call made.
    ...(apiKey
      ? []
      : [{
          type: "text" as const,
          text:
            "# This merchant\n\nThis conversation is not linked to a store. You have no tools " +
            "here: you cannot look anything up and you cannot change anything. Do not state or " +
            "imply that any change has been made.",
        }]),
  ];

  const usage = { cached: 0, written: 0, input: 0, output: 0 };
  const outcomes: ToolOutcome[] = [];
  let json: any = null;

  // Tool loop. Bounded: a model that keeps asking for lookups instead of
  // answering would otherwise spend unbounded time and money on one message.
  for (let turn = 0; turn < 4; turn++) {
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
        system,
        tools: apiKey ? TOOL_DEFINITIONS : undefined,
        messages,
      }),
    });

    if (!response.ok) {
      console.error("Anthropic error:", await response.text());
      return { ...NOT_COVERED, reason: "The answering service returned an error." };
    }

    json = await response.json();
    usage.cached += json.usage?.cache_read_input_tokens ?? 0;
    usage.written += json.usage?.cache_creation_input_tokens ?? 0;
    usage.input += json.usage?.input_tokens ?? 0;
    usage.output += json.usage?.output_tokens ?? 0;

    if (json.stop_reason !== "tool_use") break;

    const calls = (json.content ?? []).filter((b: any) => b.type === "tool_use");
    if (!calls.length) break;

    messages.push({ role: "assistant", content: json.content });

    const results = [];
    for (const call of calls) {
      const outcome = await runTool(env, call.name, apiKey, !muted);
      outcomes.push(outcome);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(outcome.result),
      });
    }
    // All tool results must go back in a SINGLE user message, or the model
    // learns to stop making parallel calls.
    messages.push({ role: "user", content: results });
  }

  const text =
    (json?.content ?? []).find((b: any) => b.type === "text")?.text ?? "";
  const toolsUsed = outcomes.map((o) => o.name);

  // An answer is sendable only if it named topics AND all of them are
  // autonomous. No topics means we cannot tell what it drew on, which is not a
  // basis for talking to a customer.
  const sendable = (topics: string[] | undefined) =>
    Array.isArray(topics) &&
    topics.length > 0 &&
    topics.every((t) => kb.autonomousTopics.has(t));

  const actionsTaken = outcomes.filter((o) => o.mutated).map((o) => o.name);
  const withheldActions = outcomes.filter((o) => o.withheld).map((o) => o.name);

  if (json.stop_reason === "refusal") {
    return { ...NOT_COVERED, reason: "The answering service declined this request.", usage, tools_used: toolsUsed, actions_taken: actionsTaken, withheld_actions: withheldActions };
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
      return { covered: false, needs_human: true, messages: [], topics_used: [], reason: "Empty answer.", usage, tools_used: toolsUsed, actions_taken: actionsTaken, withheld_actions: withheldActions };
    }
    // Only an explicit false counts as "nobody is waiting on this".
    const needsHuman = parsed.needs_human !== false;
    // A review ask is only recorded when the model says so explicitly; guessing
    // from the text would eventually mislabel and ask someone twice.
    const askedForReview = parsed.asked_for_review === true;
    return {
      ...parsed,
      needs_human: needsHuman,
      sendable: parsed.covered === true && sendable(parsed.topics_used),
      asked_to_confirm: parsed.asked_to_confirm === true,
      asked_for_review: askedForReview,
      messages,
      usage,
      tools_used: toolsUsed,
      actions_taken: actionsTaken,
      withheld_actions: withheldActions,
    };
  } catch {
    console.error("Unparseable answer. stop_reason:", json.stop_reason, "text:", text.slice(0, 300));
    return { ...NOT_COVERED, reason: "The answering service returned an unreadable response.", usage, tools_used: toolsUsed, actions_taken: actionsTaken, withheld_actions: withheldActions };
  }
}
