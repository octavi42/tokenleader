import { useState } from "react";
import { normalizeCompany, slugifyHandle } from "../handle";

export { normalizeCompany, slugifyHandle };

/** Install one-liner built from the page's own origin — the same Hono
 *  process serves both the SPA and /install. */
export function installOneLiner(
  joinRequired: boolean,
  handle?: string,
  company?: string | null,
): string {
  const base = window.location.origin;
  const name = handle && handle.length > 0 ? handle : "<your-handle>";
  return (
    `curl -fsSL ${base}/install | bash -s -- --name=${name}` +
    (joinRequired ? " --join=<code>" : "") +
    (company ? ` --company=${company}` : "")
  );
}

export function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(command);
      } else {
        // execCommand fallback: tailnet/LAN dashboards are plain http,
        // where navigator.clipboard is unavailable.
        const ta = document.createElement("textarea");
        ta.value = command;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // leave the command selectable
    }
  };

  return (
    <div className="cmd">
      <code>{command}</code>
      <button type="button" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Once the first-run hero hides, the onboarding command must still be
 *  reachable in the UI — hence this persistent footer. */
export function InstallFooter({ joinRequired }: { joinRequired: boolean }) {
  const [handle, setHandle] = useState("");
  const [company, setCompany] = useState("");
  const slug = slugifyHandle(handle);
  const companyDomain = normalizeCompany(company);
  const companyInvalid = company.trim().length > 0 && companyDomain === null;
  return (
    <footer className="page-footer">
      <details className="add-teammate">
        <summary>Add a teammate</summary>
        <p className="muted">Type their handle to get the exact command they run on their Mac:</p>
        <input
          type="text"
          className="handle-input"
          placeholder="handle, e.g. naveed"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Teammate handle"
        />
        <input
          type="text"
          className={`handle-input${companyInvalid ? " invalid" : ""}`}
          placeholder="company (optional), e.g. anara.com"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Company domain (optional)"
          aria-invalid={companyInvalid || undefined}
        />
        {companyInvalid && (
          <p className="input-error" role="alert">
            not a domain — try something like anara.com
          </p>
        )}
        <CopyableCommand command={installOneLiner(joinRequired, slug, companyDomain)} />
      </details>
    </footer>
  );
}
