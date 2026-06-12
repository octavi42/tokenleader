# tokenleader web

- Dev: `bun install && bun run dev` — Vite on :5173, proxying `/stats`, `/api`, `/health` to the server on :8787 (`bun run dev:server` in the repo root).
- Build: `bun run build` — typechecks, then emits `web/dist`.
- Serving: the Hono server serves `web/dist` at `/` (assets under `/assets/*`) when it exists; without a build it falls back to the legacy server-rendered dashboard.
