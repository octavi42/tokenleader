# Self-hosting tokenleader

## What you're hosting

One stateful container (or process): Bun + Hono + a single SQLite file in WAL
mode. Three in-process loops — daemon-binary mirror (15 min), optional Cursor
mirror (15 min), daily pricing refresh. No external database, queue, or cache.

- **Resources:** 256–512 MB RAM; CPU is negligible.
- **Disk:** give the data dir ≥1 GB. Mirrored daemon binaries are the bulk
  (~120–240 MB per cached release plus transient space during swaps); the DB
  grows slowly — token counts, not content.
- **Topology: single replica, always.** Two replicas = two SQLite writers =
  corruption. Never scale horizontally; never put the data dir on NFS/SMB.
- **TLS terminates in front of Bun, always** — a platform edge (Railway/Fly),
  Caddy, Traefik, or `tailscale serve`.

Zero required env vars; everything below is hardening. Full reference:
[configuration.md](configuration.md).

## Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/PLACEHOLDER-TEMPLATE-ID)

The template builds from the repo `Dockerfile` (`railway.json` configures the
`/health` check and a single replica), provisions a volume at `/data`, and
generates `TOKENLEADER_ADMIN_TOKEN` + `TOKENLEADER_DASHBOARD_TOKEN` — visible
under your service's **Variables**. ~$5/mo with the volume.

- Keep **app sleeping OFF** — the in-process mirror loops need the server
  running.
- Set `TOKENLEADER_SERVER_URL` to your public Railway URL once you have it.
- Railway notifies you of new upstream image versions; updating is a redeploy
  ([updating.md](updating.md)).

## Docker Compose

The repo ships a production-shaped [docker-compose.yml](../docker-compose.yml):

```sh
cp .env.example .env   # optional — compose boots with zero env
docker compose up -d
```

- The image starts as root only inside the entrypoint (to fix `/data` volume
  ownership), then drops to the unprivileged `bun` user.
- Set `TOKENLEADER_SERVER_URL` in production — hardens the rendered `/install`
  script against `X-Forwarded-Host` spoofing (boot warns while unset).
- Set `TOKENLEADER_GH_REPO` + `TOKENLEADER_GH_TOKEN` so the binary mirror can
  serve daemon installs and auto-updates
  ([configuration.md](configuration.md#daemon-binary-mirror)).
- `stop_grace_period: 30s` outlasts the server's 8 s SIGTERM drain cap — never
  lower it below that.
- HTTPS: front it with Caddy
  (`leaderboard.example.com { reverse_proxy 127.0.0.1:8787 }`) or, inside a
  tailnet, `tailscale serve --bg 8787`. When proxying locally, switch the port
  mapping to `127.0.0.1:8787:8787`.

## Fly.io

```sh
fly launch --no-deploy --ha=false      # --ha=false is load-bearing: two machines = two SQLite writers
fly volumes create tokenleader_data --size 1
fly secrets set TOKENLEADER_ADMIN_TOKEN=$(openssl rand -hex 32)
fly secrets set TOKENLEADER_SERVER_URL=https://<your-app>.fly.dev
fly deploy
```

- Keep exactly one machine (`fly scale count 1`); 512 MB recommended
  (`fly scale memory 512`).
- Deploys on a volume-attached machine are stop-then-start — a few seconds of
  downtime; daemons buffer and retry.
- Fly volumes are single-host NVMe with 5-day snapshots; add Litestream
  (below) for real durability.

~$2–3/mo for a single shared-CPU machine with a 1 GB volume.

## A machine on your desk

Any always-on Mac or Linux box works:

```sh
bun install
bun run build:server          # or: bun run dev:server for a quick look
TOKENLEADER_SERVER_URL=https://leaderboard.example.com ./bin/<server-binary>
```

Run it under launchd / systemd / tmux — anything that restarts it on crash
and reboot. For HTTPS without port-forwarding, put the box in a tailnet and
use `tailscale serve`, or any reverse proxy you already run.

## Auth and tokens

| Token | Gates | Posture |
|---|---|---|
| `TOKENLEADER_DASHBOARD_TOKEN` | viewing `/`, `/admin`, `/stats`, `/stats/*` | unset = public dashboard. Browsers get a `/login` form; the cookie lasts 30 days. |
| `TOKENLEADER_API_TOKEN` | `/api/v1/*` | unset = inherits the dashboard token. |
| `TOKENLEADER_ADMIN_TOKEN` | `POST /admin/clear` (destructive maintenance) | unset = the route returns 503 (disabled, not open). Set it explicitly and store it in your password manager — the server never generates or prints one. |
| `TOKENLEADER_JOIN_TOKEN` | first claim of NEW leaderboard names on `/ingest` | unset = open TOFU; fine on a LAN/tailnet, set it on the public internet. |

Never gated, by design: `/health`, `/ingest`, `/events/uninstall`,
`/manifest.json`, `/bin/*`, `/install`, `/uninstall`, `/login`, `/brand/*`.

## Branding

Drop `logo.svg` and `favicon.svg` into `<data-dir>/brand/` (`/data/brand/` on
Docker/Railway) — picked up within 5 minutes, no redeploy. Use theme-agnostic
SVGs. Set `TOKENLEADER_TEAM_NAME` for the header chip and page title. Details:
[configuration.md → Branding](configuration.md#branding).

## Backups

In increasing order of rigor:

1. **Platform volume snapshots** (Railway/Fly) — crash-consistent, may lose up
   to a day.
2. **`sqlite3 /data/tokenleader.sqlite ".backup /data/backup.sqlite"`** (or
   `VACUUM INTO`) via `docker exec` / `railway ssh` / `fly ssh console` — a
   WAL-safe point-in-time copy. **Never `cp` a live `.sqlite` file:** the DB
   is three files (`.sqlite`, `-wal`, `-shm`) and separating a DB from its WAL
   loses transactions.
3. **Litestream** (recommended): `docker compose --profile backup up -d` with
   the `LITESTREAM_*` env vars set (any S3-compatible bucket); config in
   [deploy/litestream.yml](../deploy/litestream.yml).

Disaster recovery — **stop the writer first** (single-writer applies to
restores too):

```sh
docker compose stop tokenleader
docker compose run --rm litestream restore -if-db-not-exists -if-replica-exists \
  -config /etc/litestream.yml /data/tokenleader.sqlite
docker compose start tokenleader
```

## Importing an existing database

Stage the file as `<db-path>.import` (default
`/data/tokenleader.sqlite.import`) and restart the container: the entrypoint
moves it over the DB (dropping stale `-wal`/`-shm`) before the server opens
it. Produce the staged file from a **stopped** source server with
`sqlite3 <old-db> ".backup ..."` — it folds the WAL in regardless of
checkpoint state.

## Operations

- **Health:** `GET /health` → `{"ok":true,"uptimeMs":...,"eventsCount":...}`.
  Wire your platform's health check to it (the shipped `railway.json` and
  `fly.toml` already do).
- **Logs:** stdout/stderr (`docker compose logs -f`, `railway logs`,
  `fly logs`). Boot echoes every resolved config knob.
- **Restart:** `docker compose restart tokenleader` / redeploy on Railway/Fly.
  In-flight requests drain for up to 8 s on SIGTERM; daemons buffer and retry,
  so brief restarts lose nothing.
- **`/manifest.json` returns 503:** either the mirror isn't configured
  (`TOKENLEADER_GH_REPO` + `TOKENLEADER_GH_TOKEN` unset — the boot log warns)
  or the first mirror tick hasn't completed yet. Daemons retry on their next
  interval.
- **Maintenance (destructive):** `POST /admin/clear` with
  `Authorization: Bearer $TOKENLEADER_ADMIN_TOKEN` and a JSON body
  `{"scope": "all" | "user" | "reset-user" | "full", "user": "alice"}` —
  see [daemon.md](daemon.md#fixing-a-403-secret-mismatch) for the
  `reset-user` flow.
- **Upgrades + rollback:** [updating.md](updating.md).

## Not supported

- **Vercel / serverless** — tokenleader needs a long-running process and a
  SQLite file on local disk; a serverless adaptation would be a rewrite.
- **Multiple replicas** — single SQLite writer, see above.
