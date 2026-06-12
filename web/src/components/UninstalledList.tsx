import type { UninstalledRow } from "../api";
import { relTime } from "../format";

// Lifetime data regardless of the active range pill (matches /stats/admin).
export function UninstalledList({
  rows,
  focusUser,
}: {
  rows: UninstalledRow[] | undefined;
  /** Focus mode: dim every other user's row (no data change). */
  focusUser?: string;
}) {
  if (!rows || rows.length === 0) return null;

  return (
    <section aria-label="Recently uninstalled">
      <div className="card">
        <table>
          <caption className="sr-only">Recently uninstalled daemons</caption>
          <thead>
            <tr>
              <th>Recently uninstalled</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.user}
                className={focusUser !== undefined && r.user !== focusUser ? "is-dimmed" : ""}
              >
                <td>{r.user}</td>
                <td className="muted">{relTime(r.uninstalledAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
