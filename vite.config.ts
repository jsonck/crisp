import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/crisp-api": {
        target: "https://api.crisp.chat",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/crisp-api/, ""),
      },
      "/anthropic-api": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/anthropic-api/, ""),
      },
    },
  },
})
