#!/usr/bin/env bash
# Post-rewrite verifier for the in-place history scrub (private migration plan,
# rev4 Addendum A). Exits non-zero on ANY hit.
#
#   scripts/scrub-verify.sh <path-to-rewritten-clone> [rules-file]
#   scripts/scrub-verify.sh --export <fast-export-file> [rules-file]
#
# IMPORTANT: always run the PRE-scrub copy of this script (your working
# checkout or the backup mirror) against the rewritten clone. The copies of
# scrub-replacements.txt INSIDE the rewritten history self-scrub into
# placeholder form by design, so a rewritten checkout cannot verify itself
# (its derived lexicon would be the placeholders, which legitimately appear
# everywhere).
#
# The forbidden lexicon is derived from scrub-replacements.txt: the left-hand
# side of every rule. Literal rules are grepped with -F -i; regex rules with
# -E -i after stripping the leading "regex:(?i)" (the rules file only uses
# ERE-compatible patterns — keep it that way).
#
# Repo mode runs three passes:
#   A. git log -p --all          — the full rewritten history with patches
#                                  (the pass the plan prescribes).
#   B. cat-file --batch-all-objects — every object in the database, raw.
#                                  Catches blobs only reachable through merge
#                                  resolutions or tags, plus anything a failed
#                                  gc left behind. If B hits but A doesn't,
#                                  run `git gc --prune=now` and re-verify.
#   C. trailer check             — zero Co-Authored-By lines and zero
#                                  "Generated with [Claude ..." lines in any
#                                  commit body or annotated tag message.
#
# Export mode runs the lexicon scan plus a line-anchored trailer heuristic
# over the fast-export stream (used by scrub-history.sh --dry-run).
set -euo pipefail
LC_ALL=C; export LC_ALL

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_GREEN=$'\033[0;32m'; C_RED=$'\033[0;31m'
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_RED=""
fi
ok()  { printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
err() { printf "  %s✗%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; }
die() { err "$@"; exit 2; }

usage() {
  cat <<EOF
usage: scripts/scrub-verify.sh <path-to-rewritten-clone> [rules-file]
       scripts/scrub-verify.sh --export <fast-export-file> [rules-file]
EOF
}

# --- args ---------------------------------------------------------------------
MODE="repo"
TARGET=""
if [ "${1:-}" = "--export" ]; then
  MODE="export"
  shift
fi
case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac
TARGET="${1:-}"
RULES="${2:-$SCRIPT_DIR/scrub-replacements.txt}"
[ -n "$TARGET" ] || { usage >&2; exit 2; }
[ -s "$RULES" ] || die "rules file missing or empty: $RULES"

FAILED=0
TMP_A=""; TMP_B=""; TMP_M=""
cleanup() { rm -f "$TMP_A" "$TMP_B" "$TMP_M"; }
trap cleanup EXIT

# Scan one dump file against every rule LHS in the rules file.
scan_file() { # $1 = dump file, $2 = label
  local dump="$1" label="$2" line lhs gmode n hits
  hits=0
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    lhs="${line%%==>*}"
    gmode="-F"
    case "$lhs" in
      regex:*)   lhs="${lhs#regex:}"; lhs="${lhs#"(?i)"}"; gmode="-E" ;;
      glob:*)    die "glob: rules are not supported by this verifier (rules file: $RULES)" ;;
      literal:*) lhs="${lhs#literal:}" ;;
    esac
    [ -n "$lhs" ] || continue
    n="$(grep -a -i -c "$gmode" -e "$lhs" "$dump" || true)"
    if [ "${n:-0}" -gt 0 ]; then
      hits=1; FAILED=1
      err "[$label] $n hit(s) for: $lhs"
      grep -a -i "$gmode" -e "$lhs" "$dump" | head -3 | cut -c1-160 | sed 's/^/        /' >&2
    fi
  done < "$RULES"
  [ "$hits" -eq 0 ] && ok "[$label] forbidden lexicon: 0 hits"
  return 0
}

# Trailer check over a file of commit/tag message bodies (or, in export mode,
# the raw stream — line-anchored, so blob lines do not false-positive as long
# as no tracked file starts a line with these phrases; ours never do).
check_trailers() { # $1 = file, $2 = label
  local f="$1" label="$2" n_co n_gen
  n_co="$(grep -a -i -c -E '^[[:space:]]*co-authored-by:' "$f" || true)"
  n_gen="$(grep -a -i -c -E '^[[:space:]]*(🤖[[:space:]]*)?generated[ -]with[[:space:]]*\[?claude' "$f" || true)"
  if [ "${n_co:-0}" -gt 0 ]; then
    FAILED=1
    err "[$label] $n_co Co-Authored-By line(s) survived"
    grep -a -i -E '^[[:space:]]*co-authored-by:' "$f" | head -3 | cut -c1-160 | sed 's/^/        /' >&2
  else
    ok "[$label] zero Co-Authored-By lines"
  fi
  if [ "${n_gen:-0}" -gt 0 ]; then
    FAILED=1
    err "[$label] $n_gen Generated-with trailer line(s) survived"
  else
    ok "[$label] zero Generated-with trailers"
  fi
  return 0
}

printf "%sscrub-verify (%s mode)%s — rules: %s\n" "$C_BOLD" "$MODE" "$C_RESET" "$RULES"

if [ "$MODE" = "export" ]; then
  [ -s "$TARGET" ] || die "export file missing or empty: $TARGET"
  scan_file "$TARGET" "fast-export stream"
  check_trailers "$TARGET" "fast-export stream (anchored heuristic)"
else
  TOP="$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null)" \
    || die "$TARGET is not inside a git work tree"
  TMP_A="$(mktemp "${TMPDIR:-/tmp}/scrub-verify-log.XXXXXX")"
  TMP_B="$(mktemp "${TMPDIR:-/tmp}/scrub-verify-obj.XXXXXX")"
  TMP_M="$(mktemp "${TMPDIR:-/tmp}/scrub-verify-msg.XXXXXX")"

  git -C "$TOP" log -p --all --no-color --no-renames > "$TMP_A" \
    || die "git log -p --all failed (empty repo?)"
  scan_file "$TMP_A" "pass A: git log -p --all"

  git -C "$TOP" cat-file --batch-all-objects --batch --unordered > "$TMP_B"
  scan_file "$TMP_B" "pass B: all objects"

  git -C "$TOP" log --all --format=%B > "$TMP_M"
  git -C "$TOP" for-each-ref refs/tags --format='%(contents)' >> "$TMP_M"
  check_trailers "$TMP_M" "pass C: commit + tag messages"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  err "${C_BOLD}VERIFICATION FAILED${C_RESET} — forbidden content survived the rewrite."
  err "Extend scripts/scrub-replacements.txt, re-run the scrub on a NEW fresh clone, and verify again."
  exit 1
fi
ok "${C_BOLD}verification clean${C_RESET} — no forbidden lexicon, no AI trailers, across all passes"
