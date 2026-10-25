import { Env } from "./index";
import { answerQuestion } from "./answer";
import {
  WEBSITE_ID,
  getRecentMessages,
  getSessionContext,
  postNote,
  sendMessage,
  isAnyoneOnline,
  type CrispMessage,
} from "./crisp";
import { loadFlow, recordFlow } from "./flow";
import { syncConversation, syncKbTags, setConversationIdentity } from "./log";
import { performHandoff, HANDOFF_QUIET_WINDOW_MS } from "./handoff";
import { fetchSiteContext } from "./site";

// If a human has spoken this recently, they're on it — a suggestion note would
// just be noise in a conversation someone is already handling.
const OPERATOR_ACTIVE_WINDOW_MS = 15 * 60 * 1000;

// How much of the conversation the model sees for context.
const HISTORY_LIMIT = 10;

// A split reply is several chat messages. Sending them in the same instant
// reads as a wall of text, so they go out a beat apart. This is the only delay
// in the flow — long enough to read naturally, not long enough to pretend
// somebody is doing manual work.
const MESSAGE_GAP_MS = 1200;

// What the bot is, said once per conversation, immediately before the first
// thing it ever says. Owned by code rather than by the prompt, because the same
// answer is read in two places: sent to a customer, where the disclosure is
// required, and shown to a support agent in the Crisp side panel, who sends it
// themselves — and a human pasting "I'm Pop Convert's AI assistant" is worse
// than no disclosure at all. handoff.ts already discloses on its own send path
// for the same reason; this makes the answer path consistent with it.
const DISCLOSURE =
  "Hi! I'm Pop Convert's AI assistant — a human can take over any time if you'd prefer.";

// When nobody is on shift, a suggested note has nobody to suggest it to: it
// sits there until someone logs in, which the transcripts show can be hours
// (one watermark request at 10:28 was answered at 16:07). An answer the bot is
// confident in is worth more to the customer than a note nobody will read, so
// out of hours a covered answer is sent regardless of its topic's autonomy.
//
// Set REPLY_WHEN_UNSTAFFED=false to switch this off without a code change —
// it is the kill switch for everything this constant enables.
const REPLY_WHEN_UNSTAFFED = process.env.REPLY_WHEN_UNSTAFFED !== "false";

// The master off switch. Set this to false and deploy, and the bot ignores
// every incoming message: no notes, no replies, no tools, no handoffs — and
// no row in bot_suggestions either, so "off" also means blind. That cost us a
// day of visibility once: a drop in watermark requests looked like a broken
// flow in the Shopify app until /health showed the bot had simply been off.
// If you want the record without the behaviour, use BOT_MUTED instead.
//
// A constant rather than an env var on purpose. Render only picks up an env
// change on a fresh deploy — a restart reuses the old environment — so the env
// var bought nothing a deploy does not, and cost a dashboard edit that is
// invisible in the repo. Here, git says who turned the bot off and when.
//
// Deliberately NOT applied to the /answer endpoint — the KB tester stays
// usable while the bot is off, which is the whole point of being able to turn
// it off and keep working on it.
export const BOT_ENABLED = true;

// Observation mode: do everything, say nothing. The pipeline runs in full —
// conversation fetched, lookups made, draft written, send decision taken — and
// then every outbound call is skipped: no customer message, no internal note,
// no handoff, and no account change (remove_watermark is refused in tools.ts).
// The row in bot_suggestions is written as usual, with `muted` true and the
// suppressed decision in `would_send_reason` / `withheld_actions`.
//
// This is the switch to reach for when the bot is misbehaving but you still
// want the data: BOT_ENABLED=false tells you nothing about what it would have
// done, and a week of muted rows tells you exactly.
//
// It costs a real Anthropic call per message and still reads the merchant's
// account, so it is not free — just harmless to the customer.
export const BOT_MUTED = true;

interface WebhookBody {
  event?: string;
  website_id?: string;
  data?: {
    session_id?: string;
    website_id?: string;
    type?: string;
    from?: string;
    origin?: string;
    content?: any;
    fingerprint?: number;
    timestamp?: number;
  };
}

async function supabase(
  env: Env,
  path: string,
  init: RequestInit & { prefer?: string } = {}
) {
  const { prefer, ...rest } = init;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...rest,
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
  });

  if (!response.ok) {
    console.error(`Supabase ${path} ${response.status}:`, await response.text());
    return null;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function textOf(content: any) {
  if (typeof content === "string") return content;
  if (content && typeof content.text === "string") return content.text;
  return "";
}

export async function handleCrispMessage(env: Env, body: WebhookBody) {
  const data = body.data ?? {};
  const sessionId = data.session_id;
  const websiteId = data.website_id ?? body.website_id;

  // Checked before the fingerprint claim, so a message that arrives while the
  // bot is off is left completely untouched: nothing written, nothing to undo,
  // and the next message after it is switched back on is handled normally.
  if (!BOT_ENABLED) {
    console.log("BOT_ENABLED is false, ignoring:", sessionId ?? "(no session)");
    return;
  }

  // `message:send` is visitor -> operators. The bot's own notes fire
  // `message:received`, so this alone prevents a self-reply loop; the
  // `from` check below is the belt to that braces.
  if (body.event !== "message:send") return;
  if (!sessionId || websiteId !== WEBSITE_ID) return;
  if (data.from !== "user") return;
  if (data.type !== "text") return;

  const question = textOf(data.content).trim();
  if (!question) return;

  // Claim the fingerprint BEFORE calling the model. Crisp retries webhooks, and
  // the unique index turns a retry into a no-op rather than a second answer.
  const fingerprint = String(data.fingerprint ?? `${sessionId}:${data.timestamp ?? ""}`);
  const claim = await supabase(env, "/bot_suggestions", {
    method: "POST",
    prefer: "return=representation,resolution=ignore-duplicates",
    body: JSON.stringify({
      website_id: websiteId,
      session_id: sessionId,
      fingerprint,
      question,
    }),
  });

  if (!claim || !Array.isArray(claim) || !claim.length) {
    console.log("Duplicate or unclaimable webhook, skipping:", fingerprint);
    return;
  }
  const rowId = claim[0].id;

  const finish = (patch: Record<string, unknown>) =>
    supabase(env, `/bot_suggestions?id=eq.${rowId}`, {
      method: "PATCH",
      body: JSON.stringify({ ...patch, completed_at: new Date().toISOString() }),
    });

  const messages = await getRecentMessages(env, sessionId);
  if (messages === null) {
    await finish({ skipped: "Could not load the conversation from Crisp." });
    return;
  }

  // Mirror what we just fetched. Deliberately before every early return below:
  // a conversation an operator is already handling is one the bot says nothing
  // about, and those are exactly the ones `bot_suggestions` could never see.
  // `complete: false` — this is the last page of messages, not the history.
  // A webhook that cannot write the mirror must still answer the customer, so
  // this is logged and swallowed rather than thrown.
  await syncConversation(env, sessionId, messages, { websiteId }).catch((e) =>
    console.error("Conversation mirror failed:", e)
  );

  // Stay quiet if a human is already in the thread. Notes are internal, but an
  // agent mid-conversation does not need the bot talking over them.
  const lastOperator = messages
    .filter((m: CrispMessage) => m.from === "operator" && m.type === "text")
    .reduce((latest: number, m: CrispMessage) => Math.max(latest, m.timestamp ?? 0), 0);

  if (lastOperator && Date.now() - lastOperator < OPERATOR_ACTIVE_WINDOW_MS) {
    await finish({ skipped: "An operator replied within the last 15 minutes." });
    return;
  }

  const history = messages
    .filter((m: CrispMessage) => m.type === "text")
    .slice(-HISTORY_LIMIT)
    .map((m: CrispMessage) => ({
      role: (m.from === "user" ? "user" : "assistant") as "user" | "assistant",
      content: textOf(m.content),
    }))
    .filter((m) => m.content);

  // The current message is already the last entry in the fetched history, so
  // drop it — answerQuestion appends the question itself.
  if (history.length && history[history.length - 1].content === question) history.pop();

  // Resolve which store this is from the api_key in the Crisp session, then look
  // up its real plan and trial state. Absent key -> no context, and the bot
  // answers generically rather than trusting anything the browser could forge.
  const session = await getSessionContext(env, sessionId);
  const apiKey = session.apiKey;
  const siteContext = await fetchSiteContext(env, apiKey);

  // The mirror was written before the store was resolved, so fill it in now.
  // "How many of our conversations can we even attribute to a merchant" is the
  // same question `site_resolved` answers per message, asked per conversation.
  // The same call already told us whether this merchant has reviewed and
  // whether they may be asked, which is the denominator for the review funnel.
  await setConversationIdentity(env, sessionId, {
    apiKey,
    hasReviewed: session.hasReviewed,
    qualification: session.qualification,
  }).catch((e) => console.error("Conversation identity write failed:", e));

  // Where the branding-removal script has got to in this conversation, plus
  // Pop Convert's own review gate.
  const flow = await loadFlow(env, sessionId, session.qualification);
  if (session.storeUrl && !flow.storeUrl) flow.storeUrl = session.storeUrl;

  const result = await answerQuestion(env, question, history, siteContext, apiKey, flow, BOT_MUTED);

  // An action the bot already performed must never read as a suggestion. In note
  // mode the customer is told nothing, so the agent has to send the reply - and
  // if the note looks like a draft they will contradict work that is already done.
  const actionLines = (result.actions_taken ?? []).map((name) =>
    name === "remove_watermark"
      ? "• Powered by Pop Convert branding has been REMOVED from this account"
      : `• ${name} was executed`
  );

  let posted = false;
  let sent = false;
  let handoff: { to: string | null; sent: boolean; wasAssigned: boolean } = {
    to: null,
    sent: false,
    wasAssigned: false,
  };

  // Not covered, and a real person is waiting: bring in a human and say so.
  // This is the branch that used to do nothing at all. Muted skips it — a
  // handoff both assigns an operator and speaks to the customer, and the row
  // records the decision anyway (covered false plus needs_human true is
  // exactly the condition that would have fired it).
  if (!result.covered && result.needs_human !== false && !BOT_MUTED) {
    const announce = !(await alreadyHandedOff(env, sessionId));
    handoff = await performHandoff(env, sessionId, result.reason ?? null, announce);
  }

  // Two independent reasons to speak to the customer rather than draft a note:
  // the topic has been promoted to autonomous, or there is nobody on shift to
  // send the draft. Unknown availability counts as staffed, so a Crisp outage
  // makes the bot quieter rather than chattier.
  const nobodyOnline =
    REPLY_WHEN_UNSTAFFED && result.covered && result.messages.length
      ? (await isAnyoneOnline(env)) === false
      : false;

  const sendReason = result.sendable
    ? "autonomous_topic"
    : nobodyOnline
      ? "nobody_online"
      : null;

  // Muted: the send decision above was still taken and is still recorded, it
  // just does not happen. Nothing is posted as a note either — a note is a
  // message in the conversation, and the team should not be reading drafts the
  // bot was told to keep to itself.
  if (BOT_MUTED) {
    console.log(
      `BOT_MUTED, nothing sent for ${sessionId}:`,
      JSON.stringify({
        covered: result.covered,
        would_send_reason: sendReason,
        withheld: result.withheld_actions ?? [],
      })
    );
  } else if (result.covered && result.messages.length && sendReason) {
    // Disclose before speaking for the first time. Deliberately not folded into
    // `sent`: that flag means the answer itself reached the customer, and it
    // drives whether the branding script advances a step.
    if (!(await alreadySpoken(env, sessionId))) {
      await sendMessage(env, sessionId, DISCLOSURE);
      await new Promise((r) => setTimeout(r, MESSAGE_GAP_MS));
    }

    for (const [i, message] of result.messages.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, MESSAGE_GAP_MS));
      const ok = await sendMessage(env, sessionId, message);
      sent = sent || ok;
    }

    // The team still gets a record, because an answer that went out unseen is
    // the thing they will most want to audit.
    posted = await postNote(
      env,
      sessionId,
      [
        sendReason === "autonomous_topic"
          ? "🤖 SENT TO THE CUSTOMER (autonomous topic)"
          : "🤖 SENT TO THE CUSTOMER (nobody was online to send it)",
        ...actionLines,
        "",
        ...result.messages,
        "",
        `— knowledge base: ${result.topics_used?.join(", ") || "none"}`,
      ].join("\n")
    );
  } else if (result.covered && result.messages.length) {
    const topics = result.topics_used?.length ? result.topics_used.join(", ") : "none";
    const draft = result.messages
      .map((m, i) => (result.messages.length > 1 ? `${i + 1}. ${m}` : m))
      .join("\n");

    const header = actionLines.length
      ? `⚠️ ALREADY DONE — do not redo, and the customer has NOT been told yet\n${actionLines.join("\n")}\n\n🤖 Reply to send`
      : "🤖 Suggested reply (not sent to the customer)";

    posted = await postNote(
      env,
      sessionId,
      `${header}\n\n${draft}\n\n— knowledge base: ${topics}${
        result.tools_used?.length ? ` · looked up: ${[...new Set(result.tools_used)].join(", ")}` : ""
      }`
    );
  } else if (actionLines.length) {
    // The action happened but there is nothing sayable. Still tell the team,
    // or a change to a merchant's account goes unrecorded in the conversation.
    posted = await postNote(
      env,
      sessionId,
      `⚠️ ALREADY DONE — the customer has NOT been told yet\n${actionLines.join("\n")}\n\nNo reply drafted: ${result.reason ?? "not covered by the knowledge base"}`
    );
  }

  // Record what this turn actually did, so the next one does not repeat it.
  // Both step markers come from the model's own response rather than from
  // pattern-matching its words, which would eventually mislabel a turn and
  // either repeat a question or skip one.
  // The removal is a real account change and is recorded either way. The two
  // conversational steps only count if the customer actually SAW them — a reply
  // that stayed a private note asked them nothing, and recording it would make
  // the next turn skip a step the merchant never received. Muting needs no
  // special case here for the same reason: nothing was sent, so `sent` is
  // false, and a muted turn moves the flow nowhere.
  const removedNow = (result.actions_taken ?? []).includes("remove_watermark");
  const askedConfirmNow = sent && result.asked_to_confirm === true;
  const askedReviewNow = sent && result.asked_for_review === true;

  if (removedNow || askedConfirmNow || askedReviewNow) {
    await recordFlow(env, sessionId, websiteId, {
      storeUrl: flow.storeUrl,
      askedConfirm: askedConfirmNow,
      removed: removedNow,
      reviewAsked: askedReviewNow,
    });
  }

  // The topics the answer drew on double as a free label on the conversation —
  // no extra inference, and it is the tag that would have answered "how many
  // watermark conversations today" without a LIKE over first messages.
  await syncKbTags(env, sessionId, result.topics_used ?? []).catch((e) =>
    console.error("KB tag write failed:", e)
  );

  await finish({
    covered: result.covered,
    answer: result.messages.join("\n") || null,
    reason: result.reason || null,
    topics_used: result.topics_used ?? [],
    posted_note: posted,
    reply_sent: sent,
    send_reason: sent ? sendReason : null,
    muted: BOT_MUTED,
    // The decision muting suppressed. Kept out of send_reason so that column
    // keeps meaning "what we really said to a customer". See 0010.
    would_send_reason: BOT_MUTED ? sendReason : null,
    withheld_actions: result.withheld_actions ?? [],
    usage: result.usage ?? null,
    site_resolved: Boolean(siteContext),
    tools_used: result.tools_used ?? [],
    actions_taken: result.actions_taken ?? [],
    needs_human: result.needs_human ?? null,
    handoff_to: handoff.to,
    handoff_sent: handoff.sent,
    was_assigned: handoff.wasAssigned,
  });
}

// Has the bot ever spoken in this conversation? Either an answer it sent or a
// handoff announcement — handoff.ts introduces itself too, so a conversation
// that has already had one does not need the disclosure again.
//
// Unbounded in time, unlike alreadyHandedOff: saying what you are is a
// once-per-conversation courtesy, not something to repeat after a quiet spell.
async function alreadySpoken(env: Env, sessionId: string) {
  const rows = await supabase(
    env,
    `/bot_suggestions?session_id=eq.${sessionId}&or=(reply_sent.is.true,handoff_sent.is.true)&select=id&limit=1`
  );
  return Array.isArray(rows) && rows.length > 0;
}

// Did we already promise this conversation a human recently? Checks our own
// record rather than the Crisp transcript: it is one indexed query, and it is
// the same source of truth the rest of this function writes to.
async function alreadyHandedOff(env: Env, sessionId: string) {
  const since = new Date(Date.now() - HANDOFF_QUIET_WINDOW_MS).toISOString();
  const rows = await supabase(
    env,
    `/bot_suggestions?session_id=eq.${sessionId}&handoff_sent=is.true&created_at=gt.${since}&select=id&limit=1`
  );
  return Array.isArray(rows) && rows.length > 0;
}
