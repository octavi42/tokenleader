import { useMemo } from "react";
import { monthPillLabel, parseMonthRange, rangePills } from "../range";

export function RangePills({ value, onChange }: { value: string; onChange: (r: string) => void }) {
  // Pills are computed once per mount; the 5s data poll re-renders the
  // page but the month window only moves on a reload.
  const pills = useMemo(() => rangePills(), []);

  // Restored month older than the trailing-12 window → prepend a pill for
  // it (before the regular months — it is the oldest), so a persisted
  // selection never renders as selected-nothing.
  const allPills = useMemo(() => {
    if (pills.some((p) => p.value === value) || !parseMonthRange(value)) {
      return pills;
    }
    const extra = { value, label: monthPillLabel(value) };
    return [...pills.slice(0, 2), extra, ...pills.slice(2)];
  }, [pills, value]);

  return (
    <span className="range" role="group" aria-label="Date range (UTC)">
      {allPills.map((p) => (
        <button
          key={p.value}
          type="button"
          aria-pressed={p.value === value}
          className={p.value === value ? "on" : ""}
          onClick={() => onChange(p.value)}
        >
          {p.label}
        </button>
      ))}
      <span className="utc-chip" title="Months are UTC calendar months">
        UTC
      </span>
    </span>
  );
}
