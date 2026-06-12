import { Link } from "@tanstack/react-router";
import type { ServerInfo } from "../api";
import { fmtBytes, fmtUptime } from "../format";

/** Slim server-meta strip at the page bottom: release version, uptime and
 *  DB size from the /stats/admin server block, plus the route into /admin. */
export function FooterMeta({ server }: { server: ServerInfo | undefined }) {
  if (!server) return null;
  return (
    <footer className="meta-strip">
      <span className="mono">tokenleader{server.version ? ` v${server.version}` : ""}</span>
      <span aria-hidden="true">·</span>
      <span>up {fmtUptime(server.uptimeMs)}</span>
      <span aria-hidden="true">·</span>
      <span>db {fmtBytes(server.dbSizeBytes)}</span>
      <span className="spacer" />
      <Link to="/admin" className="admin-link">
        Admin
      </Link>
    </footer>
  );
}
