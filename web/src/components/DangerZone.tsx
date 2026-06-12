import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AdminClearError, postAdminClear, type ClearResult, type ClearScope } from "../api";
import { fmtInt } from "../format";

const SCOPES: { value: ClearScope; label: string }[] = [
  { value: "all", label: "all — wipe events table" },
  { value: "user", label: "user — wipe one user's events" },
  { value: "reset-user", label: "reset-user — events + TOFU claim" },
  { value: "full", label: "full — drop & recreate all tables" },
];

function needsUser(scope: ClearScope): boolean {
  return scope === "user" || scope === "reset-user";
}

/** all/full are catastrophic → typed-word confirm (button stays disabled
 *  until the scope word is typed). user/reset-user keep window.confirm. */
function needsTypedConfirm(scope: ClearScope): boolean {
  return scope === "all" || scope === "full";
}

function successSummary(res: ClearResult): string {
  switch (res.scope) {
    case "all":
      return `Cleared ${fmtInt(res.removed ?? 0)} events.`;
    case "user":
      return `Cleared ${fmtInt(res.removed ?? 0)} events for '${res.user}'.`;
    case "reset-user":
      return (
        `Cleared ${fmtInt(res.removedEvents ?? 0)} events and ` +
        `${res.removedSecret ? "the TOFU claim" : "no TOFU claim"} for ` +
        `'${res.user}' — they can re-run the installer now.`
      );
    case "full":
      return "Dropped and recreated all tables.";
  }
}

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "ok"; text: string }
  | { kind: "bad"; text: string };

export function DangerZone({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<ClearScope>("all");
  const [user, setUser] = useState("");
  const [confirmWord, setConfirmWord] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const userMissing = needsUser(scope) && user.trim().length === 0;
  const confirmPending = needsTypedConfirm(scope) && confirmWord !== scope;
  const disabled = status.kind === "working" || userMissing || confirmPending || !token;

  const run = async () => {
    const target = user.trim();
    if (!needsTypedConfirm(scope)) {
      const summary =
        scope === "user"
          ? `wipe events for '${target}'`
          : `wipe events + TOFU secret for '${target}'`;
      if (!window.confirm(`Confirm: ${summary}.`)) return;
    }
    setStatus({ kind: "working" });
    try {
      const res = await postAdminClear(token, scope, needsUser(scope) ? target : undefined);
      setStatus({ kind: "ok", text: successSummary(res) });
      setConfirmWord("");
      // The dashboard data just changed out from under every query.
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
    } catch (e) {
      if (e instanceof AdminClearError) {
        const hint = e.status === 401 || e.status === 403 ? " — check the admin token" : "";
        setStatus({ kind: "bad", text: `HTTP ${e.status} — ${e.message}${hint}` });
      } else {
        setStatus({ kind: "bad", text: `network error: ${String(e)}` });
      }
    }
  };

  return (
    <section aria-label="Danger zone">
      <div className="danger-card">
        <h2 className="danger-title">Danger zone</h2>
        <div className="danger-grid">
          <div>
            <label htmlFor="clear-scope">Scope</label>
            <select
              id="clear-scope"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as ClearScope);
                setConfirmWord("");
                setStatus({ kind: "idle" });
              }}
            >
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            {scope === "reset-user" && (
              <p className="field-hint">
                The day-one 403 fix: a teammate whose daemon 403s after a reinstall gets their
                events + TOFU claim wiped, then re-runs the installer to claim a fresh secret.
              </p>
            )}
          </div>
          {needsUser(scope) && (
            <div>
              <label htmlFor="clear-user">User</label>
              <input
                id="clear-user"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="username"
                value={user}
                onChange={(e) => setUser(e.target.value)}
              />
            </div>
          )}
          {needsTypedConfirm(scope) && (
            <div>
              <label htmlFor="clear-confirm">
                Type <code>{scope}</code> to confirm
              </label>
              <input
                id="clear-confirm"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={scope}
                value={confirmWord}
                onChange={(e) => setConfirmWord(e.target.value)}
              />
            </div>
          )}
          <button
            type="button"
            className="danger-btn"
            disabled={disabled}
            onClick={() => void run()}
          >
            {status.kind === "working" ? "Working…" : "Clear DB"}
          </button>
          <p
            className={`danger-status ${status.kind === "ok" ? "ok" : status.kind === "bad" ? "bad" : ""}`}
            role="status"
            aria-live="polite"
          >
            {status.kind === "ok" || status.kind === "bad"
              ? status.text
              : status.kind === "working"
                ? "Working…"
                : "No action taken."}
          </p>
        </div>
      </div>
    </section>
  );
}
