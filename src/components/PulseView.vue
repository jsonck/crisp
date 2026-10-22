<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import {
  getDailyVolume,
  getTagDays,
  totalsByTag,
  getMedianFirstResponse,
  searchConversations,
  getConversationsByTag,
  getTags,
  addTag,
  removeTag,
  type DailyVolume,
  type TagTotal,
  type ConversationHit,
  type ConversationTag,
} from "../services/pulse";
import { isKbEditor } from "../services/kb";

const WEBSITE_ID = "293e3fde-cb94-4151-b17c-33ddbb80ca09";

const allowed = ref<boolean | null>(null);
const loading = ref(true);
const days = ref(28);

const daily = ref<DailyVolume[]>([]);
const tags = ref<TagTotal[]>([]);
const medianReply = ref<number | null>(null);

const query = ref("");
const searching = ref(false);
const results = ref<ConversationHit[] | null>(null);
const resultsLabel = ref("");

const selected = ref<ConversationHit | null>(null);
const selectedTags = ref<ConversationTag[]>([]);
const newTag = ref("");
const tagError = ref<string | null>(null);

const RANGES = [7, 28, 90];

async function load() {
  loading.value = true;
  const [volume, tagDays, median] = await Promise.all([
    getDailyVolume(days.value),
    getTagDays(days.value),
    getMedianFirstResponse(days.value),
  ]);
  daily.value = volume;
  tags.value = totalsByTag(tagDays);
  medianReply.value = median;
  loading.value = false;
}

onMounted(async () => {
  allowed.value = await isKbEditor();
  if (allowed.value) await load();
  else loading.value = false;
});

watch(days, () => {
  if (allowed.value) load();
});

// --- headline numbers ------------------------------------------------------

const totalConversations = computed(() =>
  daily.value.reduce((sum, d) => sum + Number(d.conversations ?? 0), 0)
);

const today = computed(() => {
  const key = new Date().toISOString().slice(0, 10);
  return daily.value.find((d) => d.day === key)?.conversations ?? 0;
});

const identifiedShare = computed(() => {
  const total = totalConversations.value;
  if (!total) return null;
  const identified = daily.value.reduce((sum, d) => sum + Number(d.identified ?? 0), 0);
  return Math.round((identified / total) * 100);
});

// Named for what it measures. Excluding the auto-responder brought this to
// the first message from a named agent — which the team sends as a canned
// greeting within seconds ("Hey there! Don here from CartKit"), so it is a
// real number about responsiveness, not time-to-an-answer. Separating those
// needs a judgement about message content that the data alone cannot make.
const medianLabel = computed(() => {
  const seconds = medianReply.value;
  if (seconds == null) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
});

// --- the volume chart ------------------------------------------------------

// A plain bar per day: one series, so no legend, no colour coding, and the
// only job the colour does is "this is the data". Scaled to the busiest day
// in the window rather than a fixed ceiling.
const peak = computed(() =>
  Math.max(1, ...daily.value.map((d) => Number(d.conversations ?? 0)))
);

function barHeight(value: number) {
  // A floor of 2px so a day with one conversation is visibly different from a
  // day with none — the distinction a purely proportional bar loses.
  return value > 0 ? Math.max(2, Math.round((value / peak.value) * 100)) : 0;
}

function dayLabel(day: string) {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

// Only every nth tick gets a label, so 90 days does not become a smear.
const labelEvery = computed(() => Math.ceil(daily.value.length / 12));

const maxTag = computed(() => Math.max(1, ...tags.value.map((t) => t.conversations)));

// --- drilling in -----------------------------------------------------------

async function runSearch() {
  const q = query.value.trim();
  if (!q) return;
  searching.value = true;
  selected.value = null;
  results.value = await searchConversations(q);
  resultsLabel.value = `“${q}”`;
  searching.value = false;
}

async function openTag(tag: string) {
  searching.value = true;
  selected.value = null;
  query.value = "";
  results.value = await getConversationsByTag(tag, days.value);
  resultsLabel.value = `tagged ${tag}`;
  searching.value = false;
}

async function select(hit: ConversationHit) {
  selected.value = hit;
  newTag.value = "";
  tagError.value = null;
  selectedTags.value = await getTags(hit.session_id);
}

async function submitTag() {
  if (!selected.value || !newTag.value.trim()) return;
  tagError.value = await addTag(selected.value.session_id, newTag.value);
  if (!tagError.value) {
    newTag.value = "";
    selectedTags.value = await getTags(selected.value.session_id);
    load();
  }
}

async function dropTag(tag: string) {
  if (!selected.value) return;
  tagError.value = await removeTag(selected.value.session_id, tag);
  selectedTags.value = await getTags(selected.value.session_id);
  load();
}

function crispLink(sessionId: string) {
  return `https://app.crisp.chat/website/${WEBSITE_ID}/inbox/${sessionId}/`;
}

function when(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
</script>

<template>
  <div v-if="allowed === false" class="splash">
    <div>
      <p>You are signed in, but not on the editor allowlist.</p>
      <router-link to="/kb">Back to the knowledge base</router-link>
    </div>
  </div>

  <div v-else class="pulse">
    <header>
      <h1>Pulse</h1>
      <div class="ranges">
        <button
          v-for="r in RANGES"
          :key="r"
          :class="{ active: days === r }"
          @click="days = r"
        >
          {{ r }}d
        </button>
        <router-link class="nav-link" to="/kb">Knowledge base →</router-link>
      </div>
    </header>

    <p v-if="loading" class="muted">Loading…</p>

    <template v-else>
      <section class="tiles">
        <div class="tile">
          <span class="value">{{ today }}</span>
          <span class="label">conversations today</span>
        </div>
        <div class="tile">
          <span class="value">{{ totalConversations }}</span>
          <span class="label">in the last {{ days }} days</span>
        </div>
        <div class="tile">
          <span class="value">{{ medianLabel }}</span>
          <span class="label">median first operator message</span>
        </div>
        <div class="tile">
          <span class="value">{{ identifiedShare == null ? "—" : identifiedShare + "%" }}</span>
          <span class="label">matched to a store</span>
        </div>
      </section>

      <section class="panel">
        <h2>Conversations per day</h2>
        <div v-if="!daily.length" class="muted">Nothing in this window yet.</div>
        <div v-else class="chart">
          <div
            v-for="(d, i) in daily"
            :key="d.day"
            class="col"
            :title="`${d.day}: ${d.conversations} conversations, ${d.messages} messages`"
          >
            <div class="bar" :style="{ height: barHeight(Number(d.conversations)) + '%' }"></div>
            <span class="tick">{{ i % labelEvery === 0 ? dayLabel(d.day) : "" }}</span>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>What they were about</h2>
        <p class="muted small">
          Topics the bot matched (kb), the nightly analysis (model), and anything
          tagged by hand (human). Click one to see the conversations.
        </p>
        <div v-if="!tags.length" class="muted">No tags in this window yet.</div>
        <ul v-else class="tags">
          <li v-for="t in tags.slice(0, 20)" :key="t.tag">
            <button class="tag-name" @click="openTag(t.tag)">{{ t.tag }}</button>
            <div class="tag-bar-track">
              <div
                class="tag-bar"
                :style="{ width: (t.conversations / maxTag) * 100 + '%' }"
              ></div>
            </div>
            <span class="tag-count">{{ t.conversations }}</span>
            <span class="sources">{{ t.sources.join(" · ") }}</span>
          </li>
        </ul>
      </section>

      <section class="panel">
        <h2>Search what was said</h2>
        <form class="search" @submit.prevent="runSearch">
          <input
            v-model="query"
            type="search"
            placeholder="remove the watermark, refund, not showing…"
          />
          <button type="submit" :disabled="searching">Search</button>
        </form>

        <p v-if="searching" class="muted">Searching…</p>

        <template v-else-if="results">
          <p class="muted small">
            {{ results.length }} conversation{{ results.length === 1 ? "" : "s" }}
            — {{ resultsLabel }}
          </p>
          <div class="results">
            <ul class="hits">
              <li
                v-for="hit in results"
                :key="hit.session_id"
                :class="{ active: selected?.session_id === hit.session_id }"
                @click="select(hit)"
              >
                <div class="hit-head">
                  <strong>{{ hit.nickname || hit.email || "Unknown" }}</strong>
                  <span class="muted small">{{ when(hit.started_at) }}</span>
                </div>
                <p class="excerpt">{{ hit.excerpt || hit.first_question }}</p>
              </li>
            </ul>

            <aside v-if="selected" class="detail">
              <h3>{{ selected.nickname || selected.email || "Unknown" }}</h3>
              <p class="muted small">
                {{ selected.msg_count }} messages · started {{ when(selected.started_at) }}
              </p>
              <p class="question">{{ selected.first_question }}</p>

              <h4>Tags</h4>
              <ul class="tag-list">
                <li v-for="t in selectedTags" :key="t.source + t.tag">
                  <span class="chip" :class="t.source">{{ t.tag }}</span>
                  <span class="muted small">{{ t.source }}</span>
                  <button
                    v-if="t.source === 'human'"
                    class="remove"
                    title="Remove this tag"
                    @click="dropTag(t.tag)"
                  >
                    ×
                  </button>
                </li>
                <li v-if="!selectedTags.length" class="muted small">None yet.</li>
              </ul>

              <form class="add-tag" @submit.prevent="submitTag">
                <input v-model="newTag" placeholder="add a tag" />
                <button type="submit">Add</button>
              </form>
              <p v-if="tagError" class="error">{{ tagError }}</p>

              <a :href="crispLink(selected.session_id)" target="_blank" rel="noopener">
                Open in Crisp →
              </a>
            </aside>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.pulse {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px;
  font-family: system-ui, sans-serif;
  color: #222;
}

header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 20px;
}

h1 {
  font-size: 24px;
}

.ranges {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ranges button {
  border: 1px solid #e0e0e0;
  background: #fff;
  border-radius: 6px;
  padding: 4px 10px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.ranges button.active {
  background: #3f51b5;
  border-color: #3f51b5;
  color: #fff;
}

.nav-link {
  font-size: 13px;
  color: #3f51b5;
  text-decoration: none;
  margin-left: 8px;
}

.muted {
  color: #777;
}

.small {
  font-size: 12px;
}

.error {
  color: #c62828;
  font-size: 12px;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

.tile {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tile .value {
  font-size: 26px;
  font-weight: 600;
}

.tile .label {
  font-size: 12px;
  color: #777;
}

.panel {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 20px;
}

.panel h2 {
  font-size: 15px;
  margin-bottom: 10px;
}

/* One series, so the bars carry no meaning beyond magnitude and need no
   legend. Grid and ticks stay recessive; the data is the only dark thing. */
.chart {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 140px;
  border-bottom: 1px solid #eee;
  padding-bottom: 18px;
  position: relative;
}

.col {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  position: relative;
}

.bar {
  width: 100%;
  max-width: 22px;
  background: #3f51b5;
  border-radius: 3px 3px 0 0;
}

.col:hover .bar {
  background: #283593;
}

.tick {
  position: absolute;
  bottom: -16px;
  font-size: 10px;
  color: #999;
  white-space: nowrap;
}

.tags {
  list-style: none;
}

.tags li {
  display: grid;
  grid-template-columns: 180px 1fr 40px 90px;
  align-items: center;
  gap: 10px;
  padding: 3px 0;
}

.tag-name {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: #3f51b5;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-bar-track {
  background: #f3f3f6;
  border-radius: 3px;
  height: 10px;
}

.tag-bar {
  height: 100%;
  background: #3f51b5;
  border-radius: 3px;
}

.tag-count {
  font-size: 12px;
  text-align: right;
}

.sources {
  font-size: 11px;
  color: #999;
}

.search {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.search input {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font: inherit;
  font-size: 14px;
}

.search button,
.add-tag button {
  border: 1px solid #3f51b5;
  background: #3f51b5;
  color: #fff;
  border-radius: 6px;
  padding: 7px 14px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.results {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 16px;
  align-items: start;
}

.hits {
  list-style: none;
  max-height: 420px;
  overflow-y: auto;
  border: 1px solid #eee;
  border-radius: 6px;
}

.hits li {
  padding: 10px 12px;
  border-bottom: 1px solid #f2f2f2;
  cursor: pointer;
}

.hits li:hover {
  background: #f7f7fb;
}

.hits li.active {
  background: #eef0fb;
}

.hit-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.excerpt {
  font-size: 12px;
  color: #555;
  margin-top: 3px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.detail {
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 12px;
}

.detail h3 {
  font-size: 14px;
}

.detail h4 {
  font-size: 12px;
  text-transform: uppercase;
  color: #888;
  margin: 12px 0 6px;
}

.question {
  font-size: 12px;
  color: #444;
  margin-top: 8px;
}

.tag-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tag-list li {
  display: flex;
  align-items: center;
  gap: 6px;
}

.chip {
  font-size: 12px;
  padding: 2px 7px;
  border-radius: 10px;
  background: #eef0fb;
  border: 1px solid #dfe3f7;
}

/* Source is named in text beside every chip; the tint is a second cue, never
   the only one. */
.chip.human {
  background: #e8f5e9;
  border-color: #cfe8d2;
}

.chip.model {
  background: #fff4e5;
  border-color: #f3e2c7;
}

.remove {
  border: none;
  background: none;
  color: #999;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

.add-tag {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.add-tag input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font: inherit;
  font-size: 13px;
}

.detail a {
  display: inline-block;
  margin-top: 12px;
  font-size: 13px;
  color: #3f51b5;
}

.splash {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  text-align: center;
  font-family: system-ui, sans-serif;
  color: #555;
}

@media (max-width: 760px) {
  .results {
    grid-template-columns: 1fr;
  }

  .tags li {
    grid-template-columns: 120px 1fr 32px;
  }

  .sources {
    display: none;
  }
}
</style>
