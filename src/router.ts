import { createRouter, createWebHistory } from "vue-router";
import ConversationList from "./components/ConversationList.vue";
import SnapshotView from "./components/SnapshotView.vue";
import KbEditor from "./components/KbEditor.vue";
import KbLogin from "./components/KbLogin.vue";
import { getSession } from "./services/kb";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: ConversationList },
    { path: "/snapshot/:id", component: SnapshotView },
    { path: "/kb", component: KbEditor, meta: { requiresAuth: true } },
    { path: "/kb/login", component: KbLogin },
  ],
});

router.beforeEach(async (to) => {
  if (!to.meta.requiresAuth) return true;
  const session = await getSession();
  return session ? true : { path: "/kb/login" };
});

export default router;
