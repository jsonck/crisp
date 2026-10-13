<script setup lang="ts">
import { ref } from "vue";
import { sendMagicLink } from "../services/kb";

const email = ref("");
const sending = ref(false);
const sent = ref(false);
const error = ref<string | null>(null);

async function submit() {
  if (!email.value.trim()) return;
  sending.value = true;
  error.value = null;
  const message = await sendMagicLink(email.value.trim().toLowerCase());
  sending.value = false;
  if (message) error.value = message;
  else sent.value = true;
}
</script>

<template>
  <div class="login">
    <div class="card">
      <h2>Knowledge Base</h2>

      <div v-if="sent" class="sent">
        <p>Check your inbox — we sent a sign-in link to</p>
        <p class="email">{{ email }}</p>
        <p class="hint">The link opens the editor directly. It expires shortly.</p>
      </div>

      <form v-else @submit.prevent="submit">
        <p class="hint">Sign in with your work email to edit the support bot's answers.</p>
        <input
          v-model="email"
          type="email"
          placeholder="you@cartkit.com"
          autocomplete="email"
          required
        />
        <button type="submit" :disabled="sending">
          {{ sending ? "Sending..." : "Email me a sign-in link" }}
        </button>
        <p v-if="error" class="error">{{ error }}</p>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: #f9f9f9;
}

.card {
  width: 380px;
  max-width: calc(100% - 32px);
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 10px;
  padding: 28px;
}

.card h2 {
  margin-bottom: 8px;
}

.hint {
  font-size: 13px;
  color: #666;
  margin-bottom: 16px;
}

input {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  font-family: inherit;
  border: 1px solid #ccc;
  border-radius: 6px;
  margin-bottom: 12px;
}

button {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  font-family: inherit;
  border: none;
  border-radius: 6px;
  background: #3f51b5;
  color: #fff;
  cursor: pointer;
}

button:disabled {
  background: #9fa8da;
  cursor: default;
}

.error {
  margin-top: 12px;
  font-size: 13px;
  color: #f44336;
}

.sent .email {
  font-weight: 600;
  margin: 6px 0 12px;
}
</style>
