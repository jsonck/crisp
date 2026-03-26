<script setup lang="ts">
import { ref, onMounted } from "vue";
import { listConversations, getAllMessages } from "../services/crisp";
import { analyzeConversation, type ConversationAnalysis } from "../services/analysis";
import { publishSnapshot } from "../services/supabase";

const conversations = ref<any[]>([]);
const selectedConversation = ref<any>(null);
const messages = ref<any[]>([]);
const loading = ref(false);
const loadingMessages = ref(false);
const analyzing = ref(false);
const analysis = ref<ConversationAnalysis | null>(null);
const publishing = ref(false);
const publishedUrl = ref<string | null>(null);
const page = ref(1);

async function fetchConversations() {
  loading.value = true;
  const data = await listConversations(page.value);
  if (data) conversations.value = data;
  loading.value = false;
}

async function selectConversation(conv: any) {
  selectedConversation.value = conv;
  loadingMessages.value = true;
  analysis.value = null;
  publishedUrl.value = null;
  const data = await getAllMessages(conv.session_id);
  messages.value = data || [];
  loadingMessages.value = false;
}

async function runAnalysis() {
  if (!messages.value.length) return;
  analyzing.value = true;
  analysis.value = await analyzeConversation(messages.value);
  analyzing.value = false;
}

async function publish() {
  if (!selectedConversation.value || !analysis.value) return;
  publishing.value = true;
  const id = await publishSnapshot({
    session_id: selectedConversation.value.session_id,
    nickname: selectedConversation.value.meta?.nickname || "Unknown",
    email: selectedConversation.value.meta?.email || "",
    analysis: analysis.value,
    messages: messages.value,
  });
  if (id) {
    publishedUrl.value = `${window.location.origin}/snapshot/${id}`;
    await navigator.clipboard.writeText(publishedUrl.value);
  }
  publishing.value = false;
}

function sentimentColor(sentiment: string) {
  if (sentiment === "positive") return "#4caf50";
  if (sentiment === "negative") return "#f44336";
  return "#ff9800";
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString();
}

onMounted(fetchConversations);
</script>

<template>
  <div class="container">
    <div class="sidebar">
      <h2>Conversations</h2>
      <div v-if="loading" class="loading">Loading...</div>
      <ul v-else>
        <li
          v-for="conv in conversations"
          :key="conv.session_id"
          :class="{ active: selectedConversation?.session_id === conv.session_id }"
          @click="selectConversation(conv)"
        >
          <div class="conv-name">{{ conv.meta?.nickname || "Unknown" }}</div>
          <div class="conv-preview">{{ conv.last_message?.slice(0, 80) }}</div>
          <div class="conv-time">{{ formatTime(conv.updated_at) }}</div>
        </li>
      </ul>
      <div class="pagination">
        <button :disabled="page <= 1" @click="page--; fetchConversations()">Prev</button>
        <span>Page {{ page }}</span>
        <button @click="page++; fetchConversations()">Next</button>
      </div>
    </div>

    <div class="main">
      <div v-if="!selectedConversation" class="empty">Select a conversation</div>
      <div v-else>
        <h2>{{ selectedConversation.meta?.nickname || "Unknown" }}</h2>
        <p class="conv-meta">
          {{ selectedConversation.meta?.email }} &middot;
          {{ selectedConversation.state }}
        </p>
        <button
          class="analyze-btn"
          :disabled="analyzing || !messages.length"
          @click="runAnalysis"
        >
          {{ analyzing ? "Analyzing..." : "Analyze Conversation" }}
        </button>

        <div v-if="analysis" class="analysis-panel">
          <div class="analysis-header">
            <span
              class="sentiment-badge"
              :style="{ background: sentimentColor(analysis.sentiment) }"
            >
              {{ analysis.sentiment }} ({{ analysis.sentiment_score }})
            </span>
            <span class="mood-badge">{{ analysis.customer_mood }}</span>
            <span
              class="resolution-badge"
              :class="analysis.resolution_status"
            >
              {{ analysis.resolution_status }}
            </span>
          </div>
          <p class="analysis-summary">{{ analysis.summary }}</p>
          <div v-if="analysis.topics.length" class="analysis-section">
            <strong>Topics:</strong>
            <span v-for="t in analysis.topics" :key="t" class="topic-tag">{{ t }}</span>
          </div>
          <div v-if="analysis.agent_feedback.length" class="analysis-section">
            <strong>Agent Feedback:</strong>
            <ul>
              <li v-for="(f, i) in analysis.agent_feedback" :key="i">{{ f }}</li>
            </ul>
          </div>

          <div v-if="analysis.response_suggestions?.length" class="analysis-section">
            <strong>Response Suggestions:</strong>
            <div v-for="(s, i) in analysis.response_suggestions" :key="i" class="suggestion">
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

          <div class="publish-row">
            <button
              class="publish-btn"
              :disabled="publishing"
              @click="publish"
            >
              {{ publishing ? "Publishing..." : "Publish & Copy Link" }}
            </button>
            <span v-if="publishedUrl" class="published-link">
              Copied! <a :href="publishedUrl" target="_blank">{{ publishedUrl }}</a>
            </span>
          </div>
        </div>

        <div v-if="loadingMessages" class="loading">Loading messages...</div>
        <div v-else class="messages">
          <div
            v-for="(msg, i) in messages"
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
  </div>
</template>

<style scoped>
.container {
  display: flex;
  height: 100vh;
  font-family: system-ui, sans-serif;
}

.sidebar {
  width: 360px;
  border-right: 1px solid #e0e0e0;
  overflow-y: auto;
  background: #f9f9f9;
}

.sidebar h2 {
  padding: 16px;
  margin: 0;
  border-bottom: 1px solid #e0e0e0;
}

.sidebar ul {
  list-style: none;
  margin: 0;
  padding: 0;
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

.conv-name {
  font-weight: 600;
}

.conv-preview {
  font-size: 13px;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conv-time {
  font-size: 11px;
  color: #999;
  margin-top: 4px;
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px;
  border-top: 1px solid #e0e0e0;
}

.main {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #999;
  font-size: 18px;
}

.conv-meta {
  color: #666;
  font-size: 14px;
}

.messages {
  margin-top: 16px;
}

.message {
  margin-bottom: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  max-width: 70%;
}

.message.user {
  background: #e3f2fd;
  margin-right: auto;
}

.message.operator {
  background: #f0f0f0;
  margin-left: auto;
}

.message.note {
  background: #fff9c4;
  border: 1px dashed #e0c200;
}

.note-badge {
  font-size: 9px;
  background: #e0c200;
  color: #fff;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 6px;
  vertical-align: middle;
}

.message-from {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: #888;
}

.message-content {
  margin-top: 4px;
  white-space: pre-wrap;
}

.message-time {
  font-size: 11px;
  color: #aaa;
  margin-top: 4px;
}

.loading {
  padding: 20px;
  text-align: center;
  color: #999;
}

.analyze-btn {
  margin: 12px 0;
  padding: 8px 20px;
  background: #1976d2;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}

.analyze-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.publish-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.publish-btn {
  padding: 8px 20px;
  background: #43a047;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}

.publish-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.published-link {
  font-size: 13px;
  color: #43a047;
}

.published-link a {
  color: #1976d2;
  margin-left: 4px;
}

.analysis-panel {
  background: #f5f5f5;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
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

.resolution-badge.resolved {
  background: #e8f5e9;
  color: #2e7d32;
}

.resolution-badge.unresolved {
  background: #fff3e0;
  color: #e65100;
}

.resolution-badge.needs_follow_up {
  background: #fce4ec;
  color: #c62828;
}

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

.analysis-section li {
  margin-bottom: 4px;
}

.topic-tag {
  background: #e0e0e0;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 12px;
  margin-left: 6px;
}

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
