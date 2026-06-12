import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fetchDailyTimeseries } from "../api";
import { buildDays, dateLabel, level, monthShort, quartiles, type DayCell } from "../contribution";
import { fmtCompact, fmtInt, fmtUsd } from "../format";

/** The grid is a slow YTD aggregate, so it polls on its own 60s cadence
 *  (React Query pauses refetch while the tab is hidden). */
const GRID_POLL_MS = 60_000;

const ROWS_N = 7;
const LEFT = 28;
const TOP = 20;
const GAP = 3;
const DOW_LABELS: Record<number, string> = { 1: "M", 3: "W", 5: "F" };

interface TipState {
  x: number;
  y: number;
  day: DayCell;
}

function tipText(day: DayCell): string[] {
  if (!day.inYear) return ["outside year"];
  if (day.messages === 0) return ["no activity"];
  const rows = [`${fmtInt(day.messages)} ${day.messages === 1 ? "message" : "messages"}`];
  if (day.tokens > 0) rows.push(`${fmtCompact(day.tokens)} tokens`);
  if (day.costUsd > 0) rows.push(fmtUsd(day.costUsd));
  if (day.topUser) rows.push(`top: ${day.topUser}`);
  return rows;
}

function Tooltip({ tip }: { tip: TipState }) {
  const ref = useRef<HTMLDivElement>(null);
  const pad = 12;
  const [left, setLeft] = useState(tip.x + pad);
  // Flip to the cursor's left edge when the tooltip would overflow the
  // viewport — needs the rendered width, hence the layout effect.
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    setLeft(tip.x + pad + w > window.innerWidth - 8 ? tip.x - pad - w : tip.x + pad);
  }, [tip.x]);
  return (
    <div ref={ref} className="cg-tooltip" style={{ left, top: tip.y + pad }} aria-hidden="true">
      <div className="cg-tt-date">{dateLabel(tip.day.dateMs)}</div>
      {tipText(tip.day).map((line) => (
        <div className="cg-tt-row" key={line}>
          {line}
        </div>
      ))}
    </div>
  );
}

/** GitHub-style full-year activity calendar. Always YTD — the page's range
 *  pills deliberately don't apply (the grid's whole point is the year
 *  shape). All users by default; in focus mode the same year, one user;
 *  with a ?company= filter the same year, one company. focusUser takes
 *  precedence over company (user is the narrower scope). */
export function ContributionGrid({ focusUser, company }: { focusUser?: string; company?: string }) {
  const year = new Date().getUTCFullYear();
  const since = Date.UTC(year, 0, 1);
  const scopeCompany = focusUser !== undefined ? undefined : company;

  const grid = useQuery({
    // Key includes the focused user AND company so caches are per-scope;
    // toggling back to the team re-serves the cached all-users year
    // instantly.
    queryKey: ["stats", "timeseries", "day", year, focusUser ?? "", scopeCompany ?? ""],
    queryFn: () => fetchDailyTimeseries(since, focusUser, scopeCompany),
    refetchInterval: GRID_POLL_MS,
    // Focus switch keeps the previous year's cells dimmed instead of
    // collapsing to the zero grid; errors keep rendering the last good year.
    placeholderData: keepPreviousData,
  });

  // Cell size derives from the container width (the card scrolls under
  // 8px cells).
  const innerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [tip, setTip] = useState<TipState | null>(null);

  const rows = grid.data?.rows;
  // rows === undefined → first load → zero grid (shape-true skeleton).
  const days = useMemo(() => buildDays(rows ?? [], Date.now()), [rows]);
  const cuts = useMemo(() => quartiles(days.map((d) => d.messages)), [days]);

  const cols = Math.ceil(days.length / 7);
  const availW = width || 720;
  const cell = Math.min(28, Math.max(8, Math.floor((availW - LEFT - (cols - 1) * GAP) / cols)));
  const w = LEFT + cols * cell + (cols - 1) * GAP;
  const h = TOP + ROWS_N * cell + (ROWS_N - 1) * GAP;

  // Month labels: first column whose leading day enters a new month,
  // suppressed for the previous-December padding week.
  const monthLabels = useMemo(() => {
    const labels: { x: number; label: string }[] = [];
    let lastMonth = -1;
    for (let c = 0; c < cols; c++) {
      const first = days[c * 7];
      if (!first) break;
      const d = new Date(first.dateMs);
      if (d.getUTCFullYear() !== year) continue;
      const mIdx = d.getUTCMonth();
      if (mIdx !== lastMonth) {
        labels.push({ x: LEFT + c * (cell + GAP), label: monthShort(mIdx) });
        lastMonth = mIdx;
      }
    }
    return labels;
  }, [days, cols, cell, year]);

  return (
    <div
      className={`contribution-grid${rows ? "" : " is-loading"}`}
      data-section-loading={grid.isPlaceholderData || undefined}
      onMouseLeave={() => setTip(null)}
    >
      {focusUser && <span className="focus-note">showing: {focusUser}</span>}
      <div className="cg-inner" ref={innerRef}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          role="img"
          aria-label={
            focusUser
              ? `Daily activity for ${focusUser}, ${year} (UTC)`
              : `Daily activity, ${year} (UTC)`
          }
        >
          {Object.entries(DOW_LABELS).map(([row, label]) => (
            <text
              key={label}
              className="cg-dow"
              x={0}
              y={TOP + Number(row) * (cell + GAP) + cell - 1}
            >
              {label}
            </text>
          ))}
          {monthLabels.map((m) => (
            <text key={m.label} className="cg-month" x={m.x} y={10}>
              {m.label}
            </text>
          ))}
          {days.map((day, idx) => {
            const c = Math.floor(idx / 7);
            const r = idx % 7;
            const lvl = day.inYear ? level(day.messages, cuts) : 0;
            return (
              <rect
                key={day.dateMs}
                className="cg-cell"
                x={LEFT + c * (cell + GAP)}
                y={TOP + r * (cell + GAP)}
                width={cell}
                height={cell}
                fill={`var(--cg-${lvl})`}
                onMouseEnter={(ev) => setTip({ x: ev.clientX, y: ev.clientY, day })}
                onMouseMove={(ev) => setTip({ x: ev.clientX, y: ev.clientY, day })}
                onMouseLeave={() => setTip(null)}
              >
                {/* Native + screen-reader tooltip per cell. */}
                <title>{`${dateLabel(day.dateMs)} — ${tipText(day).join(", ")}`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      {tip && <Tooltip tip={tip} />}
    </div>
  );
}
