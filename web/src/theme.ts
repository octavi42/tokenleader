/**
 * Theme: prefers-color-scheme is the default (handled in CSS); an explicit
 * toggle pins `data-theme` on <html> and persists it. The inline boot
 * script in index.html re-applies the override before first paint.
 */

const THEME_KEY = "tokenleaderTheme";

export type Theme = "dark" | "light";

export function effectiveTheme(): Theme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // best-effort
  }
}
