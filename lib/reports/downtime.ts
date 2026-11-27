// Machine downtime inside a report range (step 4.2, contracts §8.38). Pure: no database, so a test can reach every edge.

export interface MaintenanceWindow {
  startsAt: Date;
  endsAt: Date | null; // null = open until reactivated
}

const MINUTE_MS = 60_000;

/**
 * Whole minutes of `windows` that fall inside [`from`, `to`). A window with no end runs to `now`; a window planned
 * inside the range counts in full, clipped to the range. A cancelled planned window (`endsAt = startsAt`) is 0.
 * The no-overlap constraint of `machine_maintenance` (§1.5) means the windows of one machine are summed as they are.
 */
export function downtimeMinutes(windows: readonly MaintenanceWindow[], from: Date, to: Date, now: Date): number {
  let ms = 0;
  for (const w of windows) {
    const start = Math.max(w.startsAt.getTime(), from.getTime());
    const end = Math.min((w.endsAt ?? now).getTime(), to.getTime());
    if (end > start) ms += end - start;
  }
  return Math.round(ms / MINUTE_MS);
}
