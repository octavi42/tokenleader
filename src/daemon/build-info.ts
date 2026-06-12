// Build-time daemon identity, injected by scripts/build-daemon.sh via
// `bun build --define K=V`. Bun 1.1.38 requires the SPACE form; esbuild's
// colon form (`--define:K=V`) silently no-ops. Under `bun run` (dev) the
// defines never apply and the fallbacks below kick in.
//
// BUILD_VERSION is the semver release tag, or "v0.0.0-dev+<sha>" when HEAD
// isn't exactly on a tag. It rides every /ingest as X-Tokenleader-Version;
// the server compares it to the manifest version as an exact string (never
// parsed) to flag stale daemons. BUILD_SHA is diagnostics only — logged,
// never compared.
declare const __TOKENLEADER_BUILD_SHA__: string;
declare const __TOKENLEADER_BUILD_VERSION__: string;

export const BUILD_SHA: string =
  typeof __TOKENLEADER_BUILD_SHA__ !== "undefined" && __TOKENLEADER_BUILD_SHA__.length > 0
    ? __TOKENLEADER_BUILD_SHA__
    : "dev";

// Dev builds fall back to BUILD_SHA; the server's "dev" guard skips them.
export const BUILD_VERSION: string =
  typeof __TOKENLEADER_BUILD_VERSION__ !== "undefined" && __TOKENLEADER_BUILD_VERSION__.length > 0
    ? __TOKENLEADER_BUILD_VERSION__
    : BUILD_SHA;
