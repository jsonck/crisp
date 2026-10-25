import { Env } from "./index";
import { answerQuestion, type Answer } from "./answer";
import {
  getRecentMessages,
  getSessionContext,
  type CrispMessage,
} from "./crisp";
import { fetchSiteContext } from "./site";
import { loadFlow } from "./flow";

// Drafting a reply for the conversation an agent is looking at, right now.
//
// This runs the same pipeline the Crisp webhook runs — same knowledge base,
// same merchant context resolved from the Crisp session, same branding-script
// flow state, same tools — against the thread as it stands at this moment.
// It deliberately reads nothing from `bot_suggestions`: a stored row answers
// the message it was written for, and the agent is usually several messages
// past that. Mid-conversation there is no stored row at all, because the bot
// goes quiet for fifteen minutes after any operator reply, which is precisely
// when an agent wants a draft.
//
// Two things this does NOT do, both load-bearing:
//
//   * It never sends. Nothing reaches the customer and no note is posted.
//   * It runs MUTED, so account-changing tools are refused and reported in
//     `withheld_actions` instead of executed. An agent asking "what would you
//     say here" must not thereby remove a merchant's branding. Lookups still
//     run, because an answer about their plan is useless without them.
//
// Nothing is persisted either: no bot_suggestions row, no flow transition, no
// conversation tag. A draft nobody sent moved the conversation nowhere, and
// recording it would make the real webhook skip a step the customer never saw.

const HISTORY_LIMIT = 10;

export interface LiveDraft extends Answer {
  // The visitor message this answers, so the panel can show what it replied to
  // rather than leaving the agent to guess.
  question: string;
  // Whether a store was resolved from the Crisp session. False means the answer
  // is the generic one — worth saying, because the agent can see the account in
  // their own sidebar and would otherwise assume the bot could too.
  site_resolved: boolean;
  generated_at: string;
}

export type DraftOutcome =
  | { ok: true; draft: LiveDraft }
  | { ok: false; status: 502 | 404 | 409; error: string };

function textOf(content: unknown) {
  if (typeof content === "string") return content;
  if (content && typeof (content as any).text === "string") return (content as any).text;
  return "";
}

/**
 * Draft a reply for `sessionId` from the live conversation.
 *
 * The question is the most recent visitor message: that is what the bot would
 * be answering if it spoke now. Operator messages after it stay in the history,
 * so a draft written after an agent has already replied knows what was said.
 */
export async function draftReply(env: Env, sessionId: string): Promise<DraftOutcome> {
  const messages = await getRecentMessages(env, sessionId);
  if (messages === null) {
    return { ok: false, status: 502, error: "Could not load this conversation from Crisp." };
  }

  const texts = messages.filter((m: CrispMessage) => m.type === "text");

  // Walk back to the last thing the customer actually said. Everything before
  // it is history; there is nothing to answer if they have not spoken.
  const lastVisitor = [...texts].reverse().find((m: CrispMessage) => m.from === "user");
  const question = textOf(lastVisitor?.content).trim();
  if (!question) {
    return {
      ok: false,
      status: 409,
      error: "No customer message to answer in this conversation yet.",
    };
  }

  const history = texts
    .slice(-HISTORY_LIMIT)
    .map((m: CrispMessage) => ({
      role: (m.from === "user" ? "user" : "assistant") as "user" | "assistant",
      content: textOf(m.content),
    }))
    .filter((m) => m.content);

  // answerQuestion appends the question itself. Drop it from the tail of the
  // history only when it IS the tail — mid-conversation the customer's last
  // message is often followed by an operator reply, which must stay.
  if (history.length && history[history.length - 1].content === question) history.pop();

  const session = await getSessionContext(env, sessionId);
  const siteContext = await fetchSiteContext(env, session.apiKey);
  const flow = await loadFlow(env, sessionId, session.qualification);
  if (session.storeUrl && !flow.storeUrl) flow.storeUrl = session.storeUrl;

  const answer = await answerQuestion(
    env,
    question,
    history,
    siteContext,
    session.apiKey,
    flow,
    // Muted. The one argument that makes this safe to call from a button.
    true
  );

  return {
    ok: true,
    draft: {
      ...answer,
      question,
      site_resolved: Boolean(siteContext),
      generated_at: new Date().toISOString(),
    },
  };
}
