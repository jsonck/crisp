import { Env } from "./index";
import {
  getAssignee,
  getHandoffCandidates,
  getAllHandoffOperators,
  assignConversation,
  isHandoffEligible,
  operatorName,
  postNote,
  sendMessage,
} from "./crisp";

// Once someone has been told a human is coming, telling them again on every
// follow-up message is worse than saying nothing. The assignment stands; only
// the announcement is suppressed.
export const HANDOFF_QUIET_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface HandoffPlan {
  // Who ends up owning it. Null when nobody eligible could be found at all.
  target: string | null;
  targetName: string | null;
  // Operators to notify. The target when they're online; the target plus
  // whoever IS online when they aren't; the whole eligible team as a last
  // resort, so it lands somewhere rather than nowhere.
  mentions: string[];
  mentionNames: string[];
  // Did someone already own this before the bot looked? Crisp auto-assigns, so
  // usually yes — and the bot must not reassign over the top of it.
  wasAssigned: boolean;
  // Would this plan assign the conversation, or leave the existing owner be?
  wouldAssign: boolean;
  // Is the person being pointed at actually online? Governs what we promise.
  someoneOnline: boolean;
  // The exact words the customer sees.
  message: string;
}

// Decides what a handoff should do WITHOUT doing any of it. Reads live routing
// and availability; writes nothing. The test harness renders this directly, so
// what you review in the editor is what production would actually do.
//
// `sessionId` is null when there is no real conversation (the KB tester), in
// which case there is no existing assignee to respect.
export async function planHandoff(
  env: Env,
  sessionId: string | null
): Promise<HandoffPlan> {
  const [assignee, candidates] = await Promise.all([
    sessionId ? getAssignee(env, sessionId) : Promise.resolve(null),
    getHandoffCandidates(env),
  ]);

  const online = candidates ?? [];
  const wasAssigned = Boolean(assignee);

  // An assignee on the excluded list is a special case: still don't reassign,
  // but don't treat them as the target either, or the exclusion is a no-op.
  const owner = isHandoffEligible(assignee) ? assignee : null;

  let target = owner;
  let wouldAssign = false;
  if (!target && online.length) {
    target = online[0];
    wouldAssign = true;
  }

  // Only promise an immediate human when the person we are pointing at is
  // online. An away assignee plus "bringing someone in now" is the same lie as
  // claiming a change was made that wasn't.
  const someoneOnline = Boolean(target && online.includes(target));

  const preferred = [...new Set([...(target ? [target] : []), ...online])];
  const mentions = preferred.length
    ? preferred
    : (await getAllHandoffOperators(env)) ?? [];

  const message = someoneOnline
    ? "I'm an AI assistant, and I'm not sure on this one — bringing in someone from the team now."
    : "I'm an AI assistant, and I'm not sure on this one. I've flagged it for the team and they'll reply as soon as they're on.";

  return {
    target,
    targetName: target ? await operatorName(env, target) : null,
    mentions,
    mentionNames: await Promise.all(mentions.map((m) => operatorName(env, m))),
    wasAssigned,
    wouldAssign,
    someoneOnline,
    message,
  };
}

// Carries out a plan: assigns, tells the customer, and notes it for the team.
// `announce` is false when this conversation was already promised a human
// recently — the assignment still stands, only the second announcement is held.
export async function performHandoff(
  env: Env,
  sessionId: string,
  reason: string | null,
  announce: boolean
) {
  const plan = await planHandoff(env, sessionId);

  if (plan.wouldAssign && plan.target) {
    await assignConversation(env, sessionId, plan.target);
  }

  const sent = announce ? await sendMessage(env, sessionId, plan.message) : false;

  await postNote(
    env,
    sessionId,
    [
      "🤝 HANDED OFF — the bot could not answer this",
      plan.targetName
        ? `• ${plan.wasAssigned ? "Already assigned to" : "Assigned to"} ${plan.targetName}${
            plan.someoneOnline ? "" : " (away — also mentioned whoever is online)"
          }`
        : "• Nobody eligible online — mentioned the team",
      sent
        ? "• The customer has been told a human is coming"
        : "• The customer was already told earlier, so no second message was sent",
      reason ? `\nWhy the bot stopped: ${reason}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    plan.mentions
  );

  return { to: plan.target, sent, wasAssigned: plan.wasAssigned };
}
