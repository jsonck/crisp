import { createRouter, createWebHistory } from "vue-router";
import ConversationList from "./components/ConversationList.vue";
import SnapshotView from "./components/SnapshotView.vue";
import KbEditor from "./components/KbEditor.vue";
import KbLogin from "./components/KbLogin.vue";
import { getSession } from "./services/kb";
import { DEV_NO_LOGIN, devSignIn } from "./services/supabase";

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
  // Locally a session is minted for us, so /kb/login has nothing to ask for.
  // Redirect it away, including stale bookmarks, and let the guard below run
  // normally once the sign-in has settled.
  if (DEV_NO_LOGIN) {
    await devSignIn;
    if (to.path === "/kb/login") return { path: "/kb" };
  }

  if (!to.meta.requiresAuth) return true;
  const session = await getSession();
  return session ? true : { path: "/kb/login" };
});

export default router;
