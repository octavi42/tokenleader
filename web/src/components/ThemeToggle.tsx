import { useEffect } from "react";
import { effectiveTheme, setTheme } from "../theme";

function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
  );
}

/** Global `D` hotkey for the theme; renders nothing. Mounted at the route
 *  root so it works on every page. */
export function ThemeHotkey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "d" && e.key !== "D") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      setTheme(effectiveTheme() === "dark" ? "light" : "dark");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return null;
}

export function ThemeHint() {
  return (
    <span className="kbd-hint">
      Press <kbd>D</kbd> to toggle theme
    </span>
  );
}
