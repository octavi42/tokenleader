import { CopyableCommand, installOneLiner } from "./InstallSnippet";

/** First-run hero — shown while server.eventsCount === 0 (lifetime). */
export function Hero({ joinRequired }: { joinRequired: boolean }) {
  return (
    <section className="hero">
      <h1>tokenleader is live</h1>
      <p>No usage yet. Each teammate runs this on their Mac to join the leaderboard:</p>
      <CopyableCommand command={installOneLiner(joinRequired)} />
      {joinRequired && (
        <p className="muted">
          This server gates new handles — replace <code>&lt;code&gt;</code> with the join code
          (TOKENLEADER_JOIN_TOKEN) your admin shared.
        </p>
      )}
      <p className="muted">
        The daemon reads local Claude Code / Codex logs and reports token counts only — no prompt or
        code content. This page polls every 5 seconds; the first event appears automatically.
      </p>
    </section>
  );
}
