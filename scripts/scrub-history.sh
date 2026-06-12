#!/usr/bin/env bash
# git-filter-repo driver for the in-place history scrub (private migration plan,
# rev4 Addendum A). PLANNING ARTIFACT — the real rewrite (`--execute`) is run
# exactly once, by hand, following the private going-public runbook. Default
# mode is --dry-run, which changes nothing.
#
#   scripts/scrub-history.sh [--dry-run|--execute] <path-to-FRESH-clone>
#
# What it applies (always to a FRESH CLONE — never this working repo):
#   1. --replace-text scripts/scrub-replacements.txt
#        blob contents: teammate emails -> scrubbed@example.com, the Tailscale
#        Funnel URL -> https://leaderboard.example.com, the R2 bucket URL ->
#        removed, historical spend/usage figures -> fakes.
#   2. --replace-message (the same rules, applied to commit + tag messages —
#        the per-user spend totals and the Funnel URL appear in messages too).
#   3. --mailmap, generated on the fly: every author/committer identity found
#        in the clone is normalized to the canonical public identity
#        (Krish <krishnerkar@gmail.com> — plan decision K10). This covers both
#        identities present in history: Krish and the Mac mini's machine-local
#        identity.
#   4. --message-callback: strips Co-Authored-By / Generated-with trailer
#        lines from ALL commit and tag messages.
#
# Deliberately OUT of scope (fleet-compat invariants + the separate K1 rename
# decision): legacy "anara-leaderboard" asset names, the sh.anara.leaderboard
# launchd label, the anaralabs/leaderboard slug, and Anara-era BRANDING
# generally. Do not add branding rules here — 7 live daemons depend on the
# legacy names, and the rename is its own workstream.
#
# Refuses to run unless:
#   (a) git filter-repo is installed,
#   (b) the target clone's tree is clean (tracked AND untracked),
#   (c) a fresh-clone path is passed: a repo that is NOT this working checkout
#       and has no prior filter-repo state. filter-repo's own freshly-cloned
#       sanity check stays active — this script NEVER passes --force.
#
# Self-scrub property (intentional): scripts/scrub-replacements.txt is itself
# committed, so the rewrite rewrites the historical copies of the rules file
# too — every left-hand side is rewritten by its own rule (or an earlier one),
# so the rewritten history contains no copy of the forbidden lexicon. The
# flip side: the REWRITTEN checkout's scrub tooling is self-scrubbed into
# placeholder form and cannot verify anything — always run scrub-verify.sh
# from the PRE-scrub checkout or the backup mirror.
#
# NOTE on the rules-file format: git-filter-repo's --replace-text parser has
# NO comment syntax — every non-empty line is a rule. Never add comments to
# scrub-replacements.txt. Literal rules are applied first (in file order),
# then regex rules (in file order); the file is ordered to depend on that.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RULES="$SCRIPT_DIR/scrub-replacements.txt"
VERIFY="$SCRIPT_DIR/scrub-verify.sh"
CANON_IDENT="${SCRUB_CANONICAL_IDENT:-Krish <krishnerkar@gmail.com>}"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_GREEN=$'\033[0;32m'; C_RED=$'\033[0;31m'
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_RED=""
fi
ok()  { printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
err() { printf "  %s✗%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; }
die() { err "$@"; exit 1; }

usage() {
  cat <<EOF
usage: scripts/scrub-history.sh [--dry-run|--execute] <path-to-fresh-clone>

  --dry-run   (default) run git filter-repo --dry-run on the clone: nothing
              is rewritten; the original + filtered fast-export streams are
              saved under <clone>/.git/filter-repo/ and the filtered stream
              is checked against the forbidden lexicon.
  --execute   actually rewrite the clone's history. Guarded by an interactive
              confirmation (or SCRUB_CONFIRM='rewrite history' when
              non-interactive). Only ever run this following
              the private going-public runbook.

The clone must be FRESH (git clone --no-local <src> <dir>); this script
refuses to touch this working repo and never passes --force to filter-repo.
EOF
}

phys() { (cd "$1" 2>/dev/null && pwd -P); }

# --- args --------------------------------------------------------------------
MODE="dry-run"
CLONE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --execute) MODE="execute" ;;
    -h|--help) usage; exit 0 ;;
    -*) err "unknown flag: $1"; usage >&2; exit 2 ;;
    *)
      [ -z "$CLONE" ] || { err "exactly one clone path expected"; usage >&2; exit 2; }
      CLONE="$1"
      ;;
  esac
  shift
done
[ -n "$CLONE" ] || { err "missing <path-to-fresh-clone>"; usage >&2; exit 2; }

# --- preflight -----------------------------------------------------------------
printf "%sscrub-history (%s)%s\n" "$C_BOLD" "$MODE" "$C_RESET"

git filter-repo --version >/dev/null 2>&1 \
  || die "git filter-repo is not installed (brew install git-filter-repo, or pip install git-filter-repo)"
ok "git filter-repo present ($(git filter-repo --version 2>/dev/null))"

[ -d "$CLONE" ] || die "no such directory: $CLONE"
CLONE_TOP="$(git -C "$CLONE" rev-parse --show-toplevel 2>/dev/null)" \
  || die "$CLONE is not inside a git work tree"

SOURCE_TOP="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$SOURCE_TOP" ] && [ "$(phys "$CLONE_TOP")" = "$(phys "$SOURCE_TOP")" ]; then
  die "refusing to operate on this working repo ($SOURCE_TOP) — pass a FRESH clone (git clone --no-local ...)"
fi
ok "target is a separate repo: $CLONE_TOP"

if [ -n "$(git -C "$CLONE_TOP" status --porcelain)" ]; then
  git -C "$CLONE_TOP" status --short >&2
  die "target tree is not clean (tracked or untracked changes present)"
fi
ok "target tree clean"

CLONE_GITDIR="$(git -C "$CLONE_TOP" rev-parse --absolute-git-dir)"
[ ! -e "$CLONE_GITDIR/filter-repo" ] \
  || die "prior filter-repo state found ($CLONE_GITDIR/filter-repo) — make a NEW fresh clone for every run"
ok "no prior filter-repo state"

[ -s "$RULES" ] || die "rules file missing or empty: $RULES"
ok "rules file: $RULES ($(grep -c . "$RULES") rules)"

[ -x "$VERIFY" ] || die "verifier missing or not executable: $VERIFY"

# --- mailmap (generated: every identity in the clone -> canonical) -------------
MAILMAP="$(mktemp "${TMPDIR:-/tmp}/scrub-mailmap.XXXXXX")"
trap 'rm -f "$MAILMAP"' EXIT
git -C "$CLONE_TOP" log --all --format='%an <%ae>%n%cn <%ce>' | sort -u | \
  while IFS= read -r ident; do
    [ -n "$ident" ] || continue
    printf '%s %s\n' "$CANON_IDENT" "$ident"
  done > "$MAILMAP"
[ -s "$MAILMAP" ] || die "could not derive any identities from the clone (empty history?)"
echo "  mailmap (every identity normalizes to: $CANON_IDENT):"
sed 's/^/    /' "$MAILMAP"

# --- message callback: strip AI trailer lines from every commit/tag message ----
MSG_CALLBACK=""
read -r -d '' MSG_CALLBACK <<'PYEOF' || true
import re
drop = [
    re.compile(rb"(?i)^\s*co-authored-by:"),
    re.compile(rb"(?i)^\s*(\xf0\x9f\xa4\x96\s*)?generated[ -]with\b"),
]
lines = message.split(b"\n")
kept = [ln for ln in lines if not any(p.match(ln) for p in drop)]
out = b"\n".join(kept)
out = re.sub(rb"\n{3,}", b"\n\n", out)
out = out.rstrip(b"\n")
return (out + b"\n") if out else b"\n"
PYEOF

# --- confirmation gate (execute only) -------------------------------------------
if [ "$MODE" = "execute" ]; then
  printf "\n  %sTHIS REWRITES EVERY COMMIT IN %s%s\n" "$C_BOLD" "$CLONE_TOP" "$C_RESET"
  printf "  Only proceed inside the private going-public runbook.\n"
  if [ "${SCRUB_CONFIRM:-}" != "rewrite history" ]; then
    if [ -t 0 ]; then
      printf "  Type 'rewrite history' to proceed: "
      read -r answer
      [ "$answer" = "rewrite history" ] || die "aborted (confirmation not given)"
    else
      die "non-interactive: set SCRUB_CONFIRM='rewrite history' to proceed"
    fi
  fi
fi

# --- run filter-repo ------------------------------------------------------------
FILTER_ARGS=(
  --replace-text "$RULES"
  --replace-message "$RULES"
  --mailmap "$MAILMAP"
  --message-callback "$MSG_CALLBACK"
)
if [ "$MODE" = "dry-run" ]; then
  FILTER_ARGS=( --dry-run "${FILTER_ARGS[@]}" )
fi

echo
echo "Running: git filter-repo (${MODE}) in $CLONE_TOP ..."
( cd "$CLONE_TOP" && git filter-repo "${FILTER_ARGS[@]}" )
ok "git filter-repo finished"

# --- post ----------------------------------------------------------------------
if [ "$MODE" = "dry-run" ]; then
  ORIG="$CLONE_GITDIR/filter-repo/fast-export.original"
  FILT="$CLONE_GITDIR/filter-repo/fast-export.filtered"
  [ -s "$FILT" ] || die "expected filtered export at $FILT — filter-repo layout changed?"
  echo
  echo "Dry run only — nothing was rewritten. Exports:"
  echo "  original: $ORIG"
  echo "  filtered: $FILT"
  echo
  echo "Lexicon hits in the ORIGINAL export (expected: many — this is the 'before'):"
  if "$VERIFY" --export "$ORIG" "$RULES" >/dev/null 2>&1; then
    die "original export is already lexicon-clean — wrong repo, or empty rules?"
  else
    ok "original export contains forbidden strings, as expected"
  fi
  echo
  echo "Checking the FILTERED export against the forbidden lexicon (must be clean):"
  "$VERIFY" --export "$FILT" "$RULES"
  echo
  ok "dry run clean — the rules cover everything the verifier knows about"
  echo "  Next (runbook order): make a NEW fresh clone and run with --execute,"
  echo "  then verify the rewritten clone with scripts/scrub-verify.sh."
else
  echo
  ok "history rewritten in $CLONE_TOP"
  echo "  filter-repo has removed the origin remote (by design)."
  echo "  Next (private going-public runbook order):"
  echo "    1. verify from the PRE-scrub checkout:  scripts/scrub-verify.sh $CLONE_TOP"
  echo "    2. disable push-triggered workflows, lift branch protection,"
  echo "       re-add origin, force-push branches, delete old tags + releases"
  echo "    3. GitHub Support purge, THEN flip public"
fi
