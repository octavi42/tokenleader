export function fmtInt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "--";
  return Number(n).toLocaleString("en-US");
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "--";
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return String(v);
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "$0.00";
  const v = Number(n);
  if (v >= 1000) return `$${v.toFixed(0)}`;
  if (v >= 10) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

export function fmtUptime(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "--";
  let s = Math.floor(Number(ms) / 1000);
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function relTime(ts: number | null | undefined): string {
  if (!ts) return "--";
  const d = Math.max(0, Date.now() - ts);
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
