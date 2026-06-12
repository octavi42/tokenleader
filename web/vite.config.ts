import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev story: `bun run dev` in the repo root
// starts the Hono server on :8787; `bun run dev` here starts Vite, proxying
// the server routes below so the SPA talks to real data with hot reload.
export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: false }), react()],
  server: {
    proxy: {
      "/stats": "http://localhost:8787",
      "/api": "http://localhost:8787",
      "/health": "http://localhost:8787",
      "/brand": "http://localhost:8787",
    },
  },
  build: {
    outDir: "dist",
  },
});
