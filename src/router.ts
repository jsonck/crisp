import { createRouter, createWebHistory } from "vue-router";
import ConversationList from "./components/ConversationList.vue";
import SnapshotView from "./components/SnapshotView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: ConversationList },
    { path: "/snapshot/:id", component: SnapshotView },
  ],
});

export default router;
