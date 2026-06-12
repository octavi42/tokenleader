#!/usr/bin/env bash
# Server-side installer. Run once, on the Mac that will host the server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=plist-templates.sh
source "$SCRIPT_DIR/plist-templates.sh"

# --- ANSI helpers ----------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'
  C_RED=$'\033[0;31m'; C_BLUE=$'\033[0;34m'
else
  C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""
fi
info() { printf "%s>%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf "%sOK%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf "%s!!%s %s\n" "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf "%sXX%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; }

if [ "$(uname -s)" != "Darwin" ]; then
  err "Server installer only supports macOS."
  exit 1
fi

# --- build the server ------------------------------------------------------
# Always rebuild: this script gets re-run after `git pull` to pick up
# new server code, and skipping the build because old binaries exist
# silently runs stale code. Set TOKENLEADER_SKIP_BUILD=1 if you really
# want the previous binary (e.g. for fast plist-only changes).
#
# Daemon binaries are NOT built here — they're published to the
# GitHub Release the BinaryMirror watches (TOKENLEADER_GH_REPO) and served
# to teammates through this server's /install + /bin routes.
BIN_SRC="$REPO_DIR/bin/anara-leaderboard-server"
if [ -z "${TOKENLEADER_SKIP_BUILD:-}" ]; then
  info "Building server binary..."
  if ! command -v bun >/dev/null 2>&1; then
    err "bun not found. Install it from https://bun.sh and rerun."
    exit 1
  fi
  ( cd "$REPO_DIR" && bun install && bun run build:server )
fi
[ -x "$BIN_SRC" ] || { err "Build did not produce $BIN_SRC."; exit 1; }

# --- collect config --------------------------------------------------------
PORT="${PORT:-}"
if [ -z "$PORT" ]; then
  printf "Port to listen on [8787]: "
  read -r PORT
  PORT="${PORT:-8787}"
fi
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  err "Invalid port: $PORT"
  exit 1
fi

DEFAULT_DB="$HOME/Library/Application Support/tokenleader/tokenleader.sqlite"
DB_PATH="${TOKENLEADER_DB:-}"
if [ -z "$DB_PATH" ]; then
  printf "SQLite DB path [%s]: " "$DEFAULT_DB"
  read -r DB_PATH
  DB_PATH="${DB_PATH:-$DEFAULT_DB}"
fi
mkdir -p "$(dirname "$DB_PATH")"

# Public-facing URL templated into the /install bash script teammates curl.
# If unset, the server falls back to inferring it from the request Host
# header — which works fine behind Tailscale Funnel but is brittle if the
# server is hit by IP. Prompt up front so it ends up in the plist.
SERVER_URL="${TOKENLEADER_SERVER_URL:-}"
if [ -z "$SERVER_URL" ]; then
  printf "Public URL teammates will curl (blank = infer from request host): "
  read -r SERVER_URL
fi
if [ -n "$SERVER_URL" ] && ! [[ "$SERVER_URL" =~ ^https?://[^[:space:]]+$ ]]; then
  err "Public URL '$SERVER_URL' does not parse as an http(s) URL."
  exit 1
fi

# GitHub repo + token that power the in-server BinaryMirror (pulls daemon
# binaries from the repo's `latest` release every 15 minutes and serves
# them through the same URL that carries /ingest). The server itself never
# shells out to gh — the token is MATERIALIZED HERE, at install time, on
# the one machine where gh auth exists, and baked into the plist.
# Resolution: TOKENLEADER_GH_TOKEN env > `gh auth token` > prompt.
GH_REPO="${TOKENLEADER_GH_REPO:-}"
if [ -z "$GH_REPO" ]; then
  printf "GitHub repo the mirror pulls daemon releases from (owner/repo, blank = mirror off): "
  read -r GH_REPO
fi
GH_TOKEN="${TOKENLEADER_GH_TOKEN:-}"
if [ -n "$GH_REPO" ] && [ -z "$GH_TOKEN" ]; then
  if command -v gh >/dev/null 2>&1 && GH_TOKEN="$(gh auth token 2>/dev/null)" && [ -n "$GH_TOKEN" ]; then
    info "Captured GitHub token via \`gh auth token\` (baked into the plist)."
  else
    printf "GitHub token with read access to %s (blank = mirror off): " "$GH_REPO"
    read -r GH_TOKEN
  fi
fi
if [ -z "$GH_REPO" ] || [ -z "$GH_TOKEN" ]; then
  warn "Binary mirror will be OFF (needs both repo + token): /manifest.json + /bin/* will 503 and daemon auto-update is dark."
fi

# Cursor admin API key. Powers the in-server CursorMirror that polls
# Cursor's team usage API and adds source='cursor' rows to the
# leaderboard. Optional: unset = no Cursor mirroring (CC + Codex still work).
CURSOR_TOKEN="${TOKENLEADER_CURSOR_TOKEN:-}"
if [ -z "$CURSOR_TOKEN" ]; then
  printf "Cursor admin API key (crsr_…, leave blank to skip): "
  read -r CURSOR_TOKEN
fi
if [ -n "$CURSOR_TOKEN" ] && ! [[ "$CURSOR_TOKEN" =~ ^crsr_[A-Za-z0-9]+$ ]]; then
  warn "Cursor token doesn't look like a crsr_… key. Continuing anyway."
fi

# Email→handle map for the Cursor mirror. REQUIRED with the token: the
# server fails boot fast (by design) on token-without-map, so collect it
# here instead of shipping a plist that crash-loops.
CURSOR_MAP="${TOKENLEADER_CURSOR_USER_MAP:-}"
if [ -n "$CURSOR_TOKEN" ] && [ -z "$CURSOR_MAP" ]; then
  printf 'Cursor email→handle map JSON (e.g. {"a@example.com":"a"}): '
  read -r CURSOR_MAP
  if [ -z "$CURSOR_MAP" ]; then
    err "TOKENLEADER_CURSOR_TOKEN without TOKENLEADER_CURSOR_USER_MAP is a fatal server config error."
    exit 1
  fi
fi

# --- create dirs + install the server binary -------------------------------
mkdir -p "$HOME/.local/bin" \
         "$HOME/Library/LaunchAgents" \
         "$HOME/Library/Logs/anara-leaderboard"
BIN_DST="$HOME/.local/bin/anara-leaderboard-server"
cp "$BIN_SRC" "$BIN_DST"
chmod +x "$BIN_DST"
info "Ad-hoc codesigning $BIN_DST..."
# Strip quarantine / xattrs and any prior signature so the re-sign is clean.
xattr -cr "$BIN_DST" 2>/dev/null || true
codesign --remove-signature "$BIN_DST" 2>/dev/null || true
if ! codesign --force --deep --sign - "$BIN_DST" 2>/dev/null; then
  warn "codesign failed; server may be killed by Gatekeeper. Continuing."
fi

# --- render plist ----------------------------------------------------------
PLIST="$HOME/Library/LaunchAgents/sh.anara.leaderboard-server.plist"
render_server_plist "$PORT" "$DB_PATH" "$HOME" "$SERVER_URL" "$GH_TOKEN" "$CURSOR_TOKEN" "$GH_REPO" "$CURSOR_MAP" > "$PLIST"
chmod 600 "$PLIST"
if ! plutil -lint "$PLIST" >/dev/null; then
  err "Generated plist failed plutil -lint. See $PLIST."
  exit 1
fi

# --- (re)load --------------------------------------------------------------
LABEL="sh.anara.leaderboard-server"
DOMAIN="gui/$(id -u)"
info "Reloading LaunchAgent ($DOMAIN/$LABEL)..."
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootstrap refuses to load a service whose disable-state is set; clear it.
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL" || true
sleep 1
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  ok "Server loaded."
else
  err "Verification failed. Last 20 lines of stderr:"
  tail -n 20 "$HOME/Library/Logs/anara-leaderboard/stderr.log" 2>/dev/null \
    || warn "(no stderr log yet)"
  exit 1
fi

# --- next steps ------------------------------------------------------------
cat <<MSG

${C_GREEN}Server installed.${C_RESET}
  binary: ${BIN_DST}
  plist:  ${PLIST}
  db:     ${DB_PATH}
  port:   ${PORT}
  logs:   ${HOME}/Library/Logs/anara-leaderboard/{stdout,stderr}.log

Next: expose this server publicly via Tailscale Funnel.
  1. Install Tailscale on this Mac: https://tailscale.com/download
  2. tailscale funnel --bg ${PORT}
  3. Note the URL (e.g. https://your-machine.tailnet.ts.net) -- that's the TOKENLEADER_ENDPOINT for teammates.
  4. Share with team: have them curl the install script from that URL.
       curl -fsSL <url>/install | bash
     Each daemon generates its own per-user secret on first run (TOFU).
     No shared bearer token needed.
MSG
