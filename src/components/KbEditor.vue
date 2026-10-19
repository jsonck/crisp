<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  listTopics,
  listAllQaPairs,
  createTopic,
  updateTopic,
  deleteTopic,
  createQaPair,
  updateQaPair,
  deleteQaPair,
  isKbEditor,
  signOut,
  testQuestion,
  type Topic,
  type QaPair,
  type BotAnswer,
  type ChatTurn,
  type FlowState,
} from "../services/kb";

const loading = ref(true);
const allowed = ref(true);
const topics = ref<Topic[]>([]);
const qaPairs = ref<QaPair[]>([]);
const selectedId = ref<string | null>(null);

// Drafts hold unsaved edits so a half-typed answer is never written to the
// row the bot reads from.
const qaDrafts = ref<Record<string, { question: string; answer: string }>>({});
const topicDraft = ref<{ name: string; applies_when: string }>({
  name: "",
  applies_when: "",
});
const busy = ref<Record<string, boolean>>({});

// A Q&A only reaches a customer when its topic is on as well. That AND is easy
// to miss, so surface it wherever it bites.
const strandedCount = computed(() => {
  const topic = topics.value.find((t) => t.id === selectedId.value);
  if (!topic || topic.enabled) return 0;
  return qaPairs.value.filter((qa) => qa.topic_id === topic.id && qa.enabled).length;
});

const selectedTopic = computed(
  () => topics.value.find((t) => t.id === selectedId.value) ?? null
);

const visibleQaPairs = computed(() =>
  qaPairs.value.filter((qa) => qa.topic_id === selectedId.value)
);

function countFor(topicId: string) {
  const rows = qaPairs.value.filter((qa) => qa.topic_id === topicId);
  return { total: rows.length, live: rows.filter((qa) => qa.enabled).length };
}

async function load() {
  loading.value = true;
  allowed.value = await isKbEditor();
  if (!allowed.value) {
    loading.value = false;
    return;
  }

  const [t, qa] = await Promise.all([listTopics(), listAllQaPairs()]);
  topics.value = t ?? [];
  qaPairs.value = qa ?? [];
  qaDrafts.value = {};
  for (const row of qaPairs.value) {
    qaDrafts.value[row.id] = { question: row.question, answer: row.answer };
  }

  if (!selectedId.value && topics.value.length) selectTopic(topics.value[0]);
  else if (selectedTopic.value) syncTopicDraft(selectedTopic.value);

  loading.value = false;
}

function syncTopicDraft(topic: Topic) {
  topicDraft.value = {
    name: topic.name,
    applies_when: topic.applies_when ?? "",
  };
}

function selectTopic(topic: Topic) {
  selectedId.value = topic.id;
  syncTopicDraft(topic);
}

// --- topics ---------------------------------------------------------------

const topicDirty = computed(() => {
  const topic = selectedTopic.value;
  if (!topic) return false;
  return (
    topicDraft.value.name !== topic.name ||
    topicDraft.value.applies_when !== (topic.applies_when ?? "")
  );
});

async function saveTopic() {
  const topic = selectedTopic.value;
  if (!topic || !topicDirty.value) return;
  busy.value[topic.id] = true;
  await updateTopic(topic.id, {
    name: topicDraft.value.name.trim() || "Untitled topic",
    applies_when: topicDraft.value.applies_when.trim() || null,
  });
  busy.value[topic.id] = false;
  await load();
}

async function toggleTopic(topic: Topic) {
  busy.value[topic.id] = true;
  // Switching a topic off also revokes its licence to talk to customers.
  // Leaving autonomous set on a dormant topic is a trap waiting for whoever
  // turns it back on months from now.
  await updateTopic(topic.id, {
    enabled: !topic.enabled,
    ...(topic.enabled ? { autonomous: false } : {}),
  });
  busy.value[topic.id] = false;
  await load();
}

async function toggleAutonomous(topic: Topic) {
  busy.value[topic.id] = true;
  await updateTopic(topic.id, { autonomous: !topic.autonomous });
  busy.value[topic.id] = false;
  await load();
}

async function addTopic() {
  const created = await createTopic("Untitled topic", topics.value.length);
  if (!created) return;
  await load();
  selectedId.value = created.id;
  syncTopicDraft(created);
}

async function removeTopic(topic: Topic) {
  const { total } = countFor(topic.id);
  const warning =
    total > 0
      ? `Delete "${topic.name}" and its ${total} Q&A${total === 1 ? "" : "s"}? This cannot be undone.`
      : `Delete "${topic.name}"?`;
  if (!confirm(warning)) return;
  await deleteTopic(topic.id);
  selectedId.value = null;
  await load();
}

// --- q&a ------------------------------------------------------------------

function qaDirty(qa: QaPair) {
  const draft = qaDrafts.value[qa.id];
  if (!draft) return false;
  return draft.question !== qa.question || draft.answer !== qa.answer;
}

async function saveQa(qa: QaPair) {
  const draft = qaDrafts.value[qa.id];
  if (!draft || !qaDirty(qa)) return;
  busy.value[qa.id] = true;
  await updateQaPair(qa.id, { question: draft.question, answer: draft.answer });
  busy.value[qa.id] = false;
  await load();
}

async function toggleQa(qa: QaPair) {
  const draft = qaDrafts.value[qa.id];
  // Going live with blank content would put an empty answer in front of a
  // customer, so require both fields first.
  if (!qa.enabled && (!draft?.question.trim() || !draft?.answer.trim())) {
    alert("Add a question and an answer before turning this on.");
    return;
  }
  if (qaDirty(qa)) await saveQa(qa);
  busy.value[qa.id] = true;
  await updateQaPair(qa.id, { enabled: !qa.enabled });
  busy.value[qa.id] = false;

  // Switching a Q&A on inside a switched-off topic does nothing on its own,
  // which looks like the save failed. Offer the second half of the job.
  const topic = topics.value.find((t) => t.id === qa.topic_id);
  if (!qa.enabled && topic && !topic.enabled) {
    if (
      confirm(
        `"${topic.name}" is switched off, so this Q&A still won't be used.\n\nTurn the topic on now?`
      )
    ) {
      await updateTopic(topic.id, { enabled: true });
    }
  }

  await load();
}

async function addQa() {
  if (!selectedId.value) return;
  const created = await createQaPair(selectedId.value, visibleQaPairs.value.length);
  if (!created) return;
  await load();
}

async function removeQa(qa: QaPair) {
  const label = qa.question.trim() || "this empty Q&A";
  if (!confirm(`Delete ${label}?`)) return;
  await deleteQaPair(qa.id);
  await load();
}

// --- test the bot ---------------------------------------------------------
//
// A running conversation rather than one question at a time: the bot's own
// previous replies go back as history, which is the only way to exercise the
// tool loop, a follow-up question, or whether it keeps conceding once it has
// said it doesn't know.

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  // Assistant entries carry the full result so the transcript can show what
  // the reply was built from, turn by turn.
  result?: BotAnswer;
}

const testOpen = ref(false);
const testQ = ref("");
const testing = ref(false);
const testError = ref<string | null>(null);
const chat = ref<ChatEntry[]>([]);

// Prefilled from the local env so the common case — testing against a known
// store — needs no copy-paste. Gated on DEV because VITE_* values are inlined
// at build time, and this bundle is served publicly: an api_key in it would
// hand remove_watermark on a real merchant's account to anyone reading source.
// Does the tester pretend this merchant may be asked for a review? Production
// reads Pop Convert's own gate (Qualifier.qualify === "mango"); here it is a
// checkbox so both branches of the script can be rehearsed.
const testReviewAllowed = ref(true);
const testStoreUrl = ref("carmenjewel.myshopify.com");

const testApiKey = ref(
  import.meta.env.DEV ? ((import.meta.env.VITE_TEST_API_KEY as string) ?? "") : ""
);

// Only the words go back to the model — the same shape the Crisp webhook
// builds, so the prompt under test is the prompt that ships.
const history = computed<ChatTurn[]>(() =>
  chat.value.map((e) => ({ role: e.role, content: e.content }))
);

// Everything the bot changed on a real account during this conversation. Tools
// are live, so this is a record of real consequences, not a preview.
const chatActions = computed(() =>
  chat.value.flatMap((e) => e.result?.actions_taken ?? [])
);

// Totals across the conversation. Worth watching here specifically: the whole
// point of the 1h cache breakpoint is that turn two onward reads the knowledge
// base from cache instead of paying for it again.
const chatUsage = computed(() =>
  chat.value.reduce(
    (sum, e) => ({
      cached: sum.cached + (e.result?.usage?.cached ?? 0),
      written: sum.written + (e.result?.usage?.written ?? 0),
      input: sum.input + (e.result?.usage?.input ?? 0),
      output: sum.output + (e.result?.usage?.output ?? 0),
    }),
    { cached: 0, written: 0, input: 0, output: 0 }
  )
);

// Rebuilt from the step markers in replies so far, mirroring what the webhook
// would have stored in watermark_flows.
const flowState = computed<Partial<FlowState>>(() => ({
  askedConfirm: chat.value.some((e) => e.result?.asked_to_confirm),
  removed: chat.value.some((e) => e.result?.actions_taken?.includes("remove_watermark")),
  reviewAsked: chat.value.some((e) => e.result?.asked_for_review),
  reviewAllowed: testReviewAllowed.value,
  storeUrl: testStoreUrl.value.trim() || null,
}));

async function runTest() {
  const question = testQ.value.trim();
  if (!question || testing.value) return;

  testing.value = true;
  testError.value = null;

  const priorHistory = history.value;
  chat.value.push({ role: "user", content: question });
  testQ.value = "";

  const priorFlow = flowState.value;
  const { answer, error } = await testQuestion(
    question,
    priorHistory,
    testApiKey.value.trim() || null,
    priorFlow
  );

  if (error) {
    testError.value = error;
    // Put the question back rather than silently losing it.
    chat.value.pop();
    testQ.value = question;
  } else if (answer) {
    // A handoff has no customer-visible words of its own in `messages`, so the
    // transcript shows the handoff line instead — what the customer would read.
    const spoken = answer.covered
      ? answer.messages.join("\n")
      : answer.handoff?.message ?? "";
    chat.value.push({ role: "assistant", content: spoken, result: answer });
  }

  testing.value = false;
}

function resetChat() {
  chat.value = [];
  testError.value = null;
  testQ.value = "";
}

async function leave() {
  await signOut();
  window.location.href = "/kb";
}

onMounted(load);
</script>

<template>
  <div v-if="loading" class="splash">Loading knowledge base...</div>

  <div v-else-if="!allowed" class="splash blocked">
    <div>
      <h2>Not an editor yet</h2>
      <p>
        You're signed in, but your email isn't on the knowledge base editor list.
        Ask an admin to add you, then reload.
      </p>
      <button class="ghost" @click="leave">Sign out</button>
    </div>
  </div>

  <div v-else class="container">
    <div class="sidebar">
      <h2>
        Topics
        <router-link to="/" class="nav-link">Conversations</router-link>
      </h2>

      <ul>
        <li
          v-for="topic in topics"
          :key="topic.id"
          :class="{ active: topic.id === selectedId }"
          @click="selectTopic(topic)"
        >
          <div class="topic-row">
            <span class="dot" :class="{ on: topic.enabled }"></span>
            <span class="topic-name">{{ topic.name }}</span>
          </div>
          <div class="topic-count">
            {{ countFor(topic.id).live }} live / {{ countFor(topic.id).total }} total
            <span v-if="!topic.enabled && countFor(topic.id).live" class="muted-flag">
              topic off
            </span>
          </div>
        </li>
      </ul>

      <div class="sidebar-footer">
        <button @click="addTopic">+ New topic</button>
        <button class="ghost" @click="leave">Sign out</button>
      </div>
    </div>

    <div class="main">
      <div class="test-panel" :class="{ open: testOpen }">
        <button class="test-toggle" @click="testOpen = !testOpen">
          {{ testOpen ? "\u25be" : "\u25b8" }} Test the bot
          <span class="test-hint">see what a customer would get from the live Q&amp;As</span>
        </button>

        <div v-if="testOpen" class="test-body">
          <div class="test-store">
            <input
              v-model="testApiKey"
              class="store-input"
              placeholder="Store api_key (optional) — enables account lookups"
            />
            <button v-if="chat.length" class="ghost small" @click="resetChat">
              New conversation
            </button>
          </div>

          <div class="test-store">
            <input
              v-model="testStoreUrl"
              class="store-input"
              placeholder="Store URL the bot should ask them to confirm"
            />
            <label class="toggle small-toggle">
              <input type="checkbox" v-model="testReviewAllowed" />
              <span>Review-eligible</span>
            </label>
          </div>

          <p v-if="testApiKey.trim()" class="test-warn">
            ⚠ Tools are live. A watermark question will really remove that store's
            branding.
          </p>

          <div v-if="chat.length" class="transcript">
            <div v-for="(entry, i) in chat" :key="i" class="turn" :class="entry.role">
              <div v-if="entry.role === 'user'" class="bubble you">{{ entry.content }}</div>

              <template v-else>
                <p
                  v-for="(m, j) in entry.result?.covered ? entry.result.messages : [entry.content]"
                  :key="j"
                  class="bubble bot"
                  :class="{ handoff: !entry.result?.covered }"
                >
                  {{ m }}
                </p>

                <div class="turn-meta">
                  <span v-if="entry.result?.covered && entry.result.topics_used?.length">
                    {{ entry.result.topics_used.join(", ") }}
                  </span>
                  <span v-if="entry.result?.tools_used?.length" class="tools">
                    looked up: {{ [...new Set(entry.result.tools_used)].join(", ") }}
                  </span>
                  <span v-if="entry.result?.actions_taken?.length" class="did">
                    ⚠ really did: {{ entry.result.actions_taken.join(", ") }}
                  </span>
                  <span v-if="entry.result?.asked_to_confirm" class="step">
                    step: asked to confirm store
                  </span>
                  <span v-if="entry.result?.asked_for_review" class="step">
                    step: asked for review
                  </span>
                  <span v-if="entry.result?.covered" class="step">
                    {{
                      entry.result.sendable
                        ? "would SEND to customer (autonomous topic)"
                        : entry.result.nobody_online
                          ? "would SEND to customer (nobody online)"
                          : "would stay a note"
                    }}
                  </span>
                </div>

                <div v-if="entry.result && !entry.result.covered" class="handoff-box">
                  <template v-if="entry.result.needs_human === false">
                    <div class="handoff-label">No human needed</div>
                    <p class="handoff-line">
                      Treated as spam or an automated message — no reply, nobody assigned.
                    </p>
                  </template>
                  <template v-else-if="entry.result.handoff">
                    <div class="handoff-label">Would hand off (simulated)</div>
                    <p class="handoff-line">
                      {{
                        entry.result.handoff.wouldAssign
                          ? `Assign to ${entry.result.handoff.targetName}`
                          : entry.result.handoff.targetName
                            ? `Leave with ${entry.result.handoff.targetName}`
                            : "Nobody eligible online"
                      }}<span v-if="!entry.result.handoff.someoneOnline"> — away, so no instant promise</span>
                    </p>
                    <p class="handoff-line">
                      Mentions: {{ entry.result.handoff.mentionNames.join(", ") || "none" }}
                    </p>
                  </template>
                  <p v-if="entry.result.reason" class="handoff-why">
                    Why it stopped: {{ entry.result.reason }}
                  </p>
                </div>
              </template>
            </div>
          </div>

          <p v-else class="test-empty">
            Have a conversation the way a merchant would — follow-ups included.
          </p>

          <form class="test-form" @submit.prevent="runTest">
            <input
              v-model="testQ"
              :placeholder="chat.length ? 'Reply as the customer...' : 'Ask something a customer would ask...'"
              :disabled="testing"
            />
            <button type="submit" :disabled="testing || !testQ.trim()">
              {{ testing ? "..." : "Send" }}
            </button>
          </form>

          <p v-if="testError" class="test-error">{{ testError }}</p>

          <p v-if="chatActions.length" class="test-warn actions">
            ⚠ This conversation really changed the account: {{ chatActions.join(", ") }}
          </p>

          <p v-if="chat.length" class="chat-usage">
            {{ chatUsage.cached }} cached &middot;
            {{ chatUsage.written }} written to cache &middot;
            {{ chatUsage.input }} new input &middot;
            {{ chatUsage.output }} output
          </p>
        </div>
      </div>

      <div v-if="!selectedTopic" class="empty">
        {{ topics.length ? "Select a topic" : "Create your first topic to get started" }}
      </div>

      <div v-else>
        <div class="topic-header">
          <input v-model="topicDraft.name" class="topic-title" placeholder="Topic name" />
          <label class="toggle">
            <input
              type="checkbox"
              :checked="selectedTopic.enabled"
              :disabled="busy[selectedTopic.id]"
              @change="toggleTopic(selectedTopic)"
            />
            <span>{{ selectedTopic.enabled ? "Live" : "Off" }}</span>
          </label>
        </div>

        <div class="autonomy" :class="{ on: selectedTopic.autonomous }">
          <label class="toggle">
            <input
              type="checkbox"
              :checked="selectedTopic.autonomous"
              :disabled="busy[selectedTopic.id] || !selectedTopic.enabled"
              @change="toggleAutonomous(selectedTopic)"
            />
            <span>
              {{
                selectedTopic.autonomous
                  ? "Replying to customers directly"
                  : "Suggest only — an operator sends the reply"
              }}
            </span>
          </label>
          <p class="autonomy-hint">
            {{
              selectedTopic.autonomous
                ? "Answers drawn only from this topic go straight to the customer. Turn this off to stop that immediately."
                : "Turn this on once this topic's drafts have proven right. An answer that also draws on a suggest-only topic stays a suggestion."
            }}
          </p>
        </div>

        <div v-if="strandedCount" class="stranded">
          <strong>This topic is switched off.</strong>
          Its {{ strandedCount }} live Q&amp;A{{ strandedCount === 1 ? "" : "s" }}
          {{ strandedCount === 1 ? "is" : "are" }} not being used by the bot.
          <button @click="toggleTopic(selectedTopic)">Turn the topic on</button>
        </div>

        <label class="field-label">When this topic applies</label>
        <textarea
          v-model="topicDraft.applies_when"
          class="applies-when"
          rows="2"
          placeholder="e.g. Questions about billing, plans, invoices, refunds and cancellations."
        ></textarea>
        <p class="field-hint">
          This is how the bot decides whether the topic is relevant — describe the
          situation, not the answers.
        </p>

        <div class="topic-actions">
          <button :disabled="!topicDirty" @click="saveTopic">
            {{ topicDirty ? "Save topic" : "Saved" }}
          </button>
          <button class="danger ghost" @click="removeTopic(selectedTopic)">
            Delete topic
          </button>
        </div>

        <hr />

        <div v-if="!visibleQaPairs.length" class="empty-qa">
          No Q&amp;As in this topic yet.
        </div>

        <div v-for="qa in visibleQaPairs" :key="qa.id" class="qa-card">
          <div class="qa-head">
            <span class="qa-state" :class="{ on: qa.enabled }">
              {{ qa.enabled ? "live" : "off" }}
            </span>
            <label class="toggle">
              <input
                type="checkbox"
                :checked="qa.enabled"
                :disabled="busy[qa.id]"
                @change="toggleQa(qa)"
              />
              <span>{{ qa.enabled ? "On" : "Off" }}</span>
            </label>
          </div>

          <input
            v-model="qaDrafts[qa.id].question"
            class="qa-question"
            placeholder="What the customer asks"
          />
          <textarea
            v-model="qaDrafts[qa.id].answer"
            class="qa-answer"
            rows="4"
            placeholder="How the bot should answer"
          ></textarea>

          <div class="qa-actions">
            <button :disabled="!qaDirty(qa) || busy[qa.id]" @click="saveQa(qa)">
              {{ qaDirty(qa) ? "Save" : "Saved" }}
            </button>
            <span v-if="qaDirty(qa)" class="unsaved">Unsaved changes</span>
            <button class="danger ghost" @click="removeQa(qa)">Delete</button>
          </div>
        </div>

        <button class="add-qa" @click="addQa">+ Add Q&amp;A</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.container {
  display: flex;
  height: 100vh;
  font-family: system-ui, sans-serif;
}

.splash {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  color: #999;
  font-size: 18px;
  font-family: system-ui, sans-serif;
}

.splash.blocked {
  color: #333;
  text-align: center;
}

.splash.blocked p {
  max-width: 380px;
  margin: 10px auto 18px;
  font-size: 14px;
  color: #666;
}

.sidebar {
  width: 300px;
  border-right: 1px solid #e0e0e0;
  overflow-y: auto;
  background: #f9f9f9;
  display: flex;
  flex-direction: column;
}

.sidebar h2 {
  padding: 16px;
  margin: 0;
  border-bottom: 1px solid #e0e0e0;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.nav-link {
  font-size: 12px;
  font-weight: 400;
  color: #3f51b5;
  text-decoration: none;
}

.sidebar ul {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
}

.sidebar li {
  padding: 12px 16px;
  border-bottom: 1px solid #eee;
  cursor: pointer;
}

.sidebar li:hover {
  background: #eef;
}

.sidebar li.active {
  background: #ddf;
}

.topic-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topic-name {
  font-weight: 600;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ccc;
  flex-shrink: 0;
}

.dot.on {
  background: #4caf50;
}

.topic-count {
  font-size: 11px;
  color: #999;
  margin-top: 4px;
  padding-left: 16px;
}

.sidebar-footer {
  padding: 12px;
  border-top: 1px solid #e0e0e0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.main {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #999;
  font-size: 18px;
}

.topic-header {
  display: flex;
  align-items: center;
  gap: 16px;
}

.topic-title {
  flex: 1;
  font-size: 22px;
  font-weight: 600;
  font-family: inherit;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 6px 8px;
  margin-left: -8px;
}

.topic-title:hover {
  border-color: #e0e0e0;
}

.topic-title:focus {
  border-color: #3f51b5;
  outline: none;
}

.field-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: #888;
  margin: 18px 0 6px;
}

.field-hint {
  font-size: 12px;
  color: #999;
  margin-top: 6px;
}

.applies-when,
.qa-question,
.qa-answer {
  width: 100%;
  font-family: inherit;
  font-size: 14px;
  padding: 10px 12px;
  border: 1px solid #ccc;
  border-radius: 6px;
  resize: vertical;
}

.topic-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}

hr {
  border: none;
  border-top: 1px solid #e0e0e0;
  margin: 24px 0;
}

.empty-qa {
  color: #999;
  font-size: 14px;
  margin-bottom: 16px;
}

.qa-card {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 14px;
  background: #fff;
}

.qa-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.qa-state {
  font-size: 10px;
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #999;
  background: #f0f0f0;
  padding: 2px 7px;
  border-radius: 3px;
}

.qa-state.on {
  color: #fff;
  background: #4caf50;
}

.qa-question {
  font-weight: 600;
  margin-bottom: 8px;
}

.qa-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.unsaved {
  font-size: 12px;
  color: #ff9800;
  flex: 1;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #666;
  cursor: pointer;
  flex-shrink: 0;
}

.test-panel {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  margin-bottom: 20px;
  background: #fafafa;
}

.test-toggle {
  width: 100%;
  text-align: left;
  background: transparent;
  color: #333;
  font-weight: 600;
  padding: 12px 14px;
}

.test-hint {
  font-weight: 400;
  color: #999;
  font-size: 12px;
  margin-left: 8px;
}

.test-body {
  padding: 0 14px 14px;
}

.test-form {
  display: flex;
  gap: 8px;
}

.test-form input {
  flex: 1;
  font-family: inherit;
  font-size: 14px;
  padding: 9px 12px;
  border: 1px solid #ccc;
  border-radius: 6px;
}

.test-error {
  margin-top: 12px;
  font-size: 13px;
  color: #f44336;
}

.small-toggle {
  font-size: 12px;
  white-space: nowrap;
}

.turn-meta .step {
  color: #5c6bc0;
}

.autonomy {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  background: #fafafa;
}

/* Deliberately conspicuous when live: this is the one switch that lets the bot
   speak to a customer unsupervised. */
.autonomy.on {
  border-color: #a5d6a7;
  background: #f1f8f2;
}

.autonomy-hint {
  font-size: 12px;
  color: #888;
  margin-top: 5px;
}

.test-store {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.store-input {
  flex: 1;
  font-family: inherit;
  font-size: 13px;
  padding: 7px 10px;
  border: 1px solid #ddd;
  border-radius: 6px;
}

button.small {
  padding: 7px 10px;
  font-size: 12px;
}

/* Live tools can change a real merchant's account, so this is deliberately
   loud and sits both above the conversation and under it. */
.test-warn {
  font-size: 12px;
  color: #a05a00;
  background: #fff8e8;
  border: 1px solid #ffd27f;
  border-radius: 6px;
  padding: 7px 10px;
  margin-bottom: 10px;
}

.transcript {
  max-height: 420px;
  overflow-y: auto;
  padding: 4px 2px 10px;
  margin-bottom: 10px;
}

.turn.user {
  display: flex;
  justify-content: flex-end;
}

/* Rendered as chat bubbles so a split reply reads the way the customer sees it. */
.bubble {
  font-size: 14px;
  margin-top: 6px;
  padding: 8px 12px;
  border-radius: 12px 12px 12px 3px;
  max-width: 85%;
  white-space: pre-wrap;
  width: fit-content;
}

.bubble.you {
  background: #eceff1;
  border-radius: 12px 12px 3px 12px;
}

.bubble.bot {
  background: #e3f2fd;
}

/* A handoff is the bot declining, not answering — coloured to match the
   "would hand off" box rather than a normal reply. */
.bubble.bot.handoff {
  background: #fff3e0;
}

.turn-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: #999;
  margin-top: 5px;
}

.turn-meta .did {
  color: #a05a00;
  font-weight: 600;
}

.handoff-box {
  margin-top: 8px;
  padding: 8px 10px;
  border-left: 3px solid #ff9800;
  background: #fffdf8;
}

.handoff-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #888;
}

.handoff-line {
  font-size: 13px;
  margin-top: 3px;
}

.handoff-why {
  font-size: 12px;
  color: #999;
  margin-top: 5px;
}

.test-empty {
  font-size: 13px;
  color: #999;
  margin-bottom: 10px;
}

.test-warn.actions {
  margin-top: 10px;
  margin-bottom: 0;
}

.chat-usage {
  font-size: 11px;
  color: #bbb;
  margin-top: 10px;
}

.stranded {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid #ffd27f;
  background: #fff8e8;
  border-radius: 6px;
  font-size: 13px;
  color: #7a5200;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.stranded button {
  background: #ff9800;
  padding: 5px 10px;
  font-size: 12px;
}

.muted-flag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 3px;
  background: #ffe0b2;
  color: #7a5200;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}

button {
  font-family: inherit;
  font-size: 13px;
  padding: 7px 14px;
  border: none;
  border-radius: 6px;
  background: #3f51b5;
  color: #fff;
  cursor: pointer;
}

button:disabled {
  background: #e0e0e0;
  color: #999;
  cursor: default;
}

button.ghost {
  background: transparent;
  color: #666;
  border: 1px solid #ccc;
}

button.danger {
  color: #f44336;
  border-color: #f4bcb8;
}

.add-qa {
  width: 100%;
  background: transparent;
  color: #3f51b5;
  border: 1px dashed #b0b8e0;
  padding: 12px;
}
</style>
