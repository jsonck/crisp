<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute } from "vue-router";
import { getSnapshot, type Snapshot } from "../services/supabase";

const route = useRoute();
const snapshot = ref<Snapshot | null>(null);
const loading = ref(true);

function formatTime(ts: number) {
  return new Date(ts).toLocaleString();
}

function sentimentColor(sentiment: string) {
  if (sentiment === "positive") return "#4caf50";
  if (sentiment === "negative") return "#f44336";
  return "#ff9800";
}

onMounted(async () => {
  const id = route.params.id as string;
  snapshot.value = await getSnapshot(id);
  loading.value = false;
});
</script>

<template>
  <div class="snapshot-page">
    <div v-if="loading" class="loading">Loading snapshot...</div>
    <div v-else-if="!snapshot" class="loading">Snapshot not found.</div>
    <div v-else>
      <div class="snapshot-header">
        <h1>{{ snapshot.nickname || "Unknown" }}</h1>
        <p class="meta">{{ snapshot.email }} &middot; {{ snapshot.created_at }}</p>
      </div>

      <div v-if="snapshot.analysis" class="analysis-panel">
        <h2>Analysis</h2>
        <div class="analysis-header">
          <span
            class="sentiment-badge"
            :style="{ background: sentimentColor(snapshot.analysis.sentiment) }"
          >
            {{ snapshot.analysis.sentiment }} ({{ snapshot.analysis.sentiment_score }})
          </span>
          <span class="mood-badge">{{ snapshot.analysis.customer_mood }}</span>
          <span class="resolution-badge" :class="snapshot.analysis.resolution_status">
            {{ snapshot.analysis.resolution_status }}
          </span>
        </div>
        <p class="analysis-summary">{{ snapshot.analysis.summary }}</p>
        <div v-if="snapshot.analysis.topics?.length" class="analysis-section">
          <strong>Topics:</strong>
          <span v-for="t in snapshot.analysis.topics" :key="t" class="topic-tag">{{ t }}</span>
        </div>
        <div v-if="snapshot.analysis.agent_feedback?.length" class="analysis-section">
          <strong>Agent Feedback:</strong>
          <ul>
            <li v-for="(f, i) in snapshot.analysis.agent_feedback" :key="i">{{ f }}</li>
          </ul>
        </div>

        <div v-if="snapshot.analysis.response_suggestions?.length" class="analysis-section">
          <strong>Response Suggestions:</strong>
          <div v-for="(s, i) in snapshot.analysis.response_suggestions" :key="i" class="suggestion">
            <div class="suggestion-original">
              <span class="suggestion-label">Agent said:</span>
              <p>{{ s.original }}</p>
            </div>
            <div class="suggestion-better">
              <span class="suggestion-label">Could have said:</span>
              <p>{{ s.suggested }}</p>
            </div>
            <div class="suggestion-reason">
              <span class="suggestion-label">Why:</span> {{ s.reason }}
            </div>
          </div>
        </div>
      </div>

      <h2>Conversation</h2>
      <div class="messages">
        <div
          v-for="(msg, i) in snapshot.messages"
          :key="i"
          :class="['message', msg.from, { note: msg.type === 'note' }]"
        >
          <div class="message-from">
            {{ msg.from }}
            <span v-if="msg.type === 'note'" class="note-badge">note</span>
          </div>
          <div class="message-content">{{ msg.content }}</div>
          <div class="message-time">{{ formatTime(msg.timestamp) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.snapshot-page {
  max-width: 800px;
  margin: 0 auto;
  padding: 32px 20px;
  font-family: system-ui, sans-serif;
}

.snapshot-header h1 {
  margin: 0 0 4px;
}

.meta {
  color: #666;
  font-size: 14px;
  margin-bottom: 24px;
}

h2 {
  margin: 24px 0 12px;
}

.analysis-panel {
  background: #f5f5f5;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 24px;
}

.analysis-panel h2 {
  margin: 0 0 12px;
}

.analysis-header {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.sentiment-badge {
  color: #fff;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
}

.mood-badge {
  background: #e3f2fd;
  color: #1565c0;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 13px;
}

.resolution-badge {
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
}

.resolution-badge.resolved { background: #e8f5e9; color: #2e7d32; }
.resolution-badge.unresolved { background: #fff3e0; color: #e65100; }
.resolution-badge.needs_follow_up { background: #fce4ec; color: #c62828; }

.analysis-summary {
  font-size: 14px;
  line-height: 1.5;
  margin-bottom: 12px;
}

.analysis-section {
  margin-top: 10px;
  font-size: 14px;
}

.analysis-section ul {
  margin: 6px 0 0 18px;
  padding: 0;
}

.analysis-section li { margin-bottom: 4px; }

.topic-tag {
  background: #e0e0e0;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 12px;
  margin-left: 6px;
}

.messages { margin-top: 16px; }

.message {
  margin-bottom: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  max-width: 70%;
}

.message.user { background: #e3f2fd; margin-right: auto; }
.message.operator { background: #f0f0f0; margin-left: auto; }
.message.note { background: #fff9c4; border: 1px dashed #e0c200; }

.note-badge {
  font-size: 9px;
  background: #e0c200;
  color: #fff;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 6px;
}

.message-from {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: #888;
}

.message-content { margin-top: 4px; white-space: pre-wrap; }
.message-time { font-size: 11px; color: #aaa; margin-top: 4px; }
.loading { padding: 40px; text-align: center; color: #999; font-size: 18px; }

.suggestion {
  margin-top: 12px;
  padding: 12px;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
}

.suggestion-original {
  background: #ffebee;
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 8px;
}

.suggestion-better {
  background: #e8f5e9;
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 8px;
}

.suggestion-original p,
.suggestion-better p {
  margin: 4px 0 0;
  white-space: pre-wrap;
}

.suggestion-label {
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  color: #666;
}

.suggestion-reason {
  font-size: 13px;
  color: #555;
  font-style: italic;
}
</style>
