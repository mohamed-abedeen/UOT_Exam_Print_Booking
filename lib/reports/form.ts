// Browser-safe helpers of the reports screen (step 4.2): the default range, the tab labels, minutes and percent text.
// Pure: no database, no server-only import.

export type ReportTab = "colleges" | "machines" | "stock" | "peak";

export const REPORT_TABS: readonly { key: ReportTab; label: string }[] = [
  { key: "colleges", label: "الكليات" },
  { key: "machines", label: "الآلات" },
  { key: "stock", label: "الهدر والمخزون" },
  { key: "peak", label: "ساعات الذروة" },
];

/** The first day of `today`'s month up to `today` (owner, 2026-11-27, step 4.2). */
export function defaultRange(today: string): { from: string; to: string } {
  return { from: `${today.slice(0, 8)}01`, to: today };
}

/** 25 of 200 → '12.5'; one decimal, no trailing zero. `null` when `whole` is 0. */
export function percentText(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  const value = Math.round((part / whole) * 1000) / 10;
  return String(value);
}
