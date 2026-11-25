// The scheduling lock and the loader of `ctx` (contracts §3 intro, §3.9).
// A transaction that writes a placement calls takeSchedulingLock() first, then loadContext() on the same `tx`.
import "server-only";
import { and, eq, gt, gte, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Executor, Tx } from "@/db";
import { bookings, holidays, machineMaintenance, machines, saturdayRequests, settings as settingsTable } from "@/db/schema";
import { atMinutes, localDate } from "./time";
import type { Busy, ScheduleContext, Settings } from "./types";

/** One scheduling lock for the whole centre; a constant, not a setting (contracts §5). */
export const SCHEDULING_LOCK_KEY = 7001;

/** Waits for the lock; it is released when the transaction ends. Read the clock only after this returns. */
export async function takeSchedulingLock(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(String(SCHEDULING_LOCK_KEY))})`);
}

const SETTING_KEYS = {
  work_start: "workStart",
  work_end: "workEnd",
  working_weekdays: "workingWeekdays",
  large_job_threshold: "largeJobThreshold",
  large_jobs_per_day: "largeJobsPerDay",
  edit_deadline_minutes: "editDeadlineMinutes",
  delay_deadline_minutes: "delayDeadlineMinutes",
  suggestion_search_days: "suggestionSearchDays",
  part_warn_percent: "partWarnPercent",
} as const satisfies Record<string, keyof Settings>;

export async function loadSettings(ex: Executor): Promise<Settings> {
  const rows = await ex.select({ key: settingsTable.key, value: settingsTable.value }).from(settingsTable);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(SETTING_KEYS)) {
    if (!byKey.has(key)) throw new Error(`settings: missing key "${key}" (run the seed)`);
    out[field] = byKey.get(key);
  }
  return out as unknown as Settings;
}

/**
 * Everything the pure functions need, from today on. "Holding" rows (every status except cancelled and no_show)
 * occupy their interval — the same rows the constraint `bookings_no_overlap` covers.
 * `ignoreBookingId` (an edit, a delay notice or a move of that booking) leaves it out of `busy`, `loadMinutes`,
 * `largeJobsByDate` and `usedImpressions`. `saturdayApprovals`: this college's approved requests from today on;
 * `usedImpressions` = its holding bookings that day, own and on behalf (contracts §3.3).
 */
export async function loadContext(
  ex: Executor,
  opts: { now: Date; collegeId: number; ignoreBookingId?: number },
): Promise<ScheduleContext> {
  const today = localDate(opts.now);
  const startOfToday = atMinutes(today, 0);

  const settings = await loadSettings(ex);
  const holidayRows = await ex.select({ date: holidays.date }).from(holidays).where(gte(holidays.date, today));
  const machineRows = await ex
    .select({
      id: machines.id,
      minSheets: machines.minSheets,
      maxSheets: machines.maxSheets,
      supportsDuplex: machines.supportsDuplex,
      speedPerHour: machines.speedPerHour,
      setupMinutesPerModel: machines.setupMinutesPerModel,
      priority: machines.priority,
      archivedAt: machines.archivedAt,
    })
    .from(machines);
  const bookingRows = await ex
    .select({
      id: bookings.id,
      machineId: bookings.machineId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      workDate: bookings.workDate,
      impressions: bookings.impressions,
      collegeId: bookings.collegeId,
    })
    .from(bookings)
    .where(
      and(
        notInArray(bookings.status, ["cancelled", "no_show"]),
        gte(bookings.workDate, today),
        opts.ignoreBookingId === undefined ? undefined : ne(bookings.id, opts.ignoreBookingId),
      ),
    );
  const approvalRows = await ex
    .select({ date: saturdayRequests.date, approvedQuantity: saturdayRequests.approvedQuantity })
    .from(saturdayRequests)
    .where(
      and(
        eq(saturdayRequests.collegeId, opts.collegeId),
        eq(saturdayRequests.status, "approved"),
        gte(saturdayRequests.date, today),
      ),
    );
  // A cancelled planned window has ends_at = starts_at (an empty range): it blocks nothing.
  const maintenanceRows = await ex
    .select({
      machineId: machineMaintenance.machineId,
      startsAt: machineMaintenance.startsAt,
      endsAt: machineMaintenance.endsAt,
    })
    .from(machineMaintenance)
    .where(
      or(
        isNull(machineMaintenance.endsAt),
        and(gt(machineMaintenance.endsAt, machineMaintenance.startsAt), gt(machineMaintenance.endsAt, startOfToday)),
      ),
    );

  const busy: Busy[] = [];
  const largeJobsByDate = new Map<string, number>();
  const load = new Map<string, number>();
  const used = new Map<string, number>(); // this college's impressions per date
  for (const b of bookingRows) {
    const date = b.workDate!;
    if (b.collegeId === opts.collegeId) used.set(date, (used.get(date) ?? 0) + b.impressions!);
    busy.push({ machineId: b.machineId, start: b.startsAt, end: b.endsAt, bookingId: b.id });
    if (b.impressions! > settings.largeJobThreshold) largeJobsByDate.set(date, (largeJobsByDate.get(date) ?? 0) + 1);
    const key = `${b.machineId}|${date}`;
    load.set(key, (load.get(key) ?? 0) + (b.endsAt.getTime() - b.startsAt.getTime()) / 60_000);
  }
  for (const m of maintenanceRows) busy.push({ machineId: m.machineId, start: m.startsAt, end: m.endsAt });

  return {
    now: opts.now,
    collegeId: opts.collegeId,
    settings,
    holidays: new Set(holidayRows.map((h) => h.date)),
    saturdayApprovals: approvalRows.map((a) => ({
      date: a.date,
      approvedQuantity: a.approvedQuantity!,
      usedImpressions: used.get(a.date) ?? 0,
    })),
    machines: machineRows,
    busy,
    largeJobsByDate,
    loadMinutes: (machineId, date) => load.get(`${machineId}|${date}`) ?? 0,
    ignoreBookingId: opts.ignoreBookingId,
  };
}
