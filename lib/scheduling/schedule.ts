// Scheduling core (contracts §3.1–3.7): pure functions. Everything comes in through `ctx`;
// nothing here reads the clock or the database.
import { addDays, addMinutes, atMinutes, ceilToGrid, localDate, minutesOfDay, SLOT_MINUTES, weekdayOf } from "./time";
import type { JobSpec, Machine, Placement, Quantities, Refusal, ScheduleContext, Window } from "./types";

// Whole-number division, so no result depends on floating-point rounding.
function floorDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}
function ceilDiv(a: number, b: number): number {
  return floorDiv(a, b) + (a % b === 0 ? 0 : 1);
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// ---- §3.1 Quantities

export function quantities(job: JobSpec): Quantities {
  const sheetsPerCopy = job.sides === "duplex" ? ceilDiv(job.pagesPerModel, 2) : job.pagesPerModel;
  return {
    impressions: job.models * job.pagesPerModel * job.copies,
    sheets: job.models * job.copies * sheetsPerCopy,
  };
}

// ---- §3.2 Duration

/** models × setup + impressions × 60 ÷ speed, rounded up to the 10-minute grid, at least one slot. */
export function durationMinutes(job: JobSpec, m: Machine): number {
  const { impressions } = quantities(job);
  const slots = ceilDiv(
    job.models * m.setupMinutesPerModel * m.speedPerHour + impressions * 60,
    m.speedPerHour * SLOT_MINUTES,
  );
  return Math.max(1, slots) * SLOT_MINUTES;
}

// ---- §3.3 Eligible machines and their order

export function isStaticEligible(job: JobSpec, m: Machine): boolean {
  return (
    m.archivedAt === null &&
    (job.sides === "single" || m.supportsDuplex) &&
    (m.maxSheets === null || m.maxSheets >= quantities(job).impressions)
  );
}

/** 0 when the job is inside the machine's range; otherwise the larger machine's lower bound. */
export function tierGroup(m: Machine, impressions: number): number {
  return m.minSheets <= impressions ? 0 : m.minSheets;
}

export function isFreeOn(m: Machine, interval: { start: Date; end: Date }, ctx: ScheduleContext): boolean {
  const start = interval.start.getTime();
  const end = interval.end.getTime();
  return !ctx.busy.some(
    (b) =>
      b.machineId === m.id &&
      (b.bookingId === undefined || b.bookingId !== ctx.ignoreBookingId) &&
      b.start.getTime() < end &&
      (b.end === null || b.end.getTime() > start),
  );
}

/**
 * The static-eligible machines in the order they win a tie at the same start:
 * tierGroup, priority, loadMinutes that day, id.
 */
export function eligibleMachines(job: JobSpec, date: string, ctx: ScheduleContext): Machine[] {
  const { impressions } = quantities(job);
  return ctx.machines
    .filter((m) => isStaticEligible(job, m))
    .map((m) => ({ m, key: [tierGroup(m, impressions), m.priority, ctx.loadMinutes(m.id, date), m.id] }))
    .sort((a, b) => compareKeys(a.key, b.key))
    .map(({ m }) => m);
}

// ---- §3.4 Working calendar

function dayMinutes(ctx: ScheduleContext): number {
  return minutesOfDay(ctx.settings.workEnd) - minutesOfDay(ctx.settings.workStart);
}

function isWorkingWeekday(date: string, ctx: ScheduleContext): boolean {
  return ctx.settings.workingWeekdays.includes(weekdayOf(date));
}

function approvalFor(date: string, ctx: ScheduleContext) {
  return ctx.saturdayApprovals.find((a) => a.date === date);
}

export function workingWindow(date: string, ctx: ScheduleContext): Window | null {
  if (ctx.holidays.has(date)) return null;
  if (!isWorkingWeekday(date, ctx) && !approvalFor(date, ctx)) return null;
  return {
    open: atMinutes(date, minutesOfDay(ctx.settings.workStart)),
    close: atMinutes(date, minutesOfDay(ctx.settings.workEnd)),
  };
}

export function dayRefusal(job: JobSpec, date: string, ctx: ScheduleContext): Refusal | null {
  if (!workingWindow(date, ctx)) return "day_closed";
  const { impressions } = quantities(job);
  if (
    impressions > ctx.settings.largeJobThreshold &&
    (ctx.largeJobsByDate.get(date) ?? 0) >= ctx.settings.largeJobsPerDay
  ) {
    return "large_job_limit";
  }
  if (!isWorkingWeekday(date, ctx)) {
    const approval = approvalFor(date, ctx);
    if (approval && approval.usedImpressions + impressions > approval.approvedQuantity) return "saturday_quota";
  }
  return null;
}

// ---- §3.5 Free-interval search

/** Free grid starts of a static-eligible machine inside an open window; the day rules are the caller's. */
function startsInWindow(job: JobSpec, m: Machine, window: Window, ctx: ScheduleContext): Date[] {
  const duration = durationMinutes(job, m);
  const earliest = new Date(Math.max(window.open.getTime(), ceilToGrid(ctx.now).getTime()));
  const close = window.close.getTime();
  const starts: Date[] = [];
  for (let s = earliest; s.getTime() + duration * 60_000 <= close; s = addMinutes(s, SLOT_MINUTES)) {
    if (isFreeOn(m, { start: s, end: addMinutes(s, duration) }, ctx)) starts.push(s);
  }
  return starts;
}

export function freeStarts(job: JobSpec, m: Machine, date: string, ctx: ScheduleContext): Date[] {
  if (!isStaticEligible(job, m) || dayRefusal(job, date, ctx) !== null) return [];
  const window = workingWindow(date, ctx);
  return window ? startsInWindow(job, m, window, ctx) : [];
}

function placement(job: JobSpec, m: Machine, start: Date): Placement {
  return { machineId: m.id, startsAt: start, endsAt: addMinutes(start, durationMinutes(job, m)) };
}

export function placeInHour(job: JobSpec, date: string, hour: number, ctx: ScheduleContext): Placement | Refusal {
  const firstStart = atMinutes(date, hour * 60).getTime();
  const lastStart = firstStart + (60 - SLOT_MINUTES) * 60_000;

  if (date < localDate(ctx.now) || lastStart < ceilToGrid(ctx.now).getTime()) return "past";

  const machines = eligibleMachines(job, date, ctx);
  if (machines.length === 0) return "no_machine";
  if (!machines.some((m) => durationMinutes(job, m) <= dayMinutes(ctx))) return "too_long";

  const window = workingWindow(date, ctx);
  // Also closed when no grid start of the hour lies inside [work_start, work_end).
  if (!window || lastStart < window.open.getTime() || firstStart >= window.close.getTime()) return "day_closed";
  const refusal = dayRefusal(job, date, ctx);
  if (refusal) return refusal;

  const { impressions } = quantities(job);
  let best: { m: Machine; start: Date; key: number[] } | null = null;
  // `machines` is already in (tierGroup, priority, loadMinutes, id) order, so on an equal
  // (tierGroup, start) the first one seen wins.
  for (const m of machines) {
    const start = startsInWindow(job, m, window, ctx).find((s) => s.getTime() >= firstStart && s.getTime() <= lastStart);
    if (!start) continue;
    const key = [tierGroup(m, impressions), start.getTime()];
    if (!best || compareKeys(key, best.key) < 0) best = { m, start, key };
  }
  return best ? placement(job, best.m, best.start) : "hour_full";
}

export function nearestFreeStart(job: JobSpec, date: string, hour: number, ctx: ScheduleContext): Placement | Refusal {
  const today = localDate(ctx.now);
  const startDate = date < today ? today : date;
  const { impressions } = quantities(job);

  for (let offset = 0; offset <= ctx.settings.suggestionSearchDays; offset++) {
    const day = addDays(startDate, offset);
    if (dayRefusal(job, day, ctx) !== null) continue;
    const window = workingWindow(day, ctx);
    if (!window) continue;

    const wanted = atMinutes(day, hour * 60).getTime();
    let best: { m: Machine; start: Date; key: number[] } | null = null;
    // Same ordering trick as placeInHour: ties on (distance, tierGroup, start) go to the first machine.
    for (const m of eligibleMachines(job, day, ctx)) {
      for (const start of startsInWindow(job, m, window, ctx)) {
        const key = [Math.abs(start.getTime() - wanted), tierGroup(m, impressions), start.getTime()];
        if (!best || compareKeys(key, best.key) < 0) best = { m, start, key };
      }
    }
    if (best) return placement(job, best.m, best.start);
  }
  return "no_free_slot";
}

// ---- §3.7 Delay notice

/**
 * The latest free start after the booking's own start, same date, on any static-eligible machine (a larger one too).
 * `ctx` must be loaded with `ignoreBookingId` = this booking. Ties at the same start go to the first machine in
 * (tierGroup, priority, loadMinutes, id) order. Null = no free start later that day.
 */
export function latestFreeStart(booking: JobSpec & { startsAt: Date }, ctx: ScheduleContext): Placement | null {
  const date = localDate(booking.startsAt);
  const after = booking.startsAt.getTime();
  let best: { m: Machine; start: Date } | null = null;
  for (const m of eligibleMachines(booking, date, ctx)) {
    const starts = freeStarts(booking, m, date, ctx);
    const latest = starts.length > 0 ? starts[starts.length - 1] : undefined;
    if (!latest || latest.getTime() <= after) continue;
    if (!best || latest.getTime() > best.start.getTime()) best = { m, start: latest };
  }
  return best ? placement(booking, best.m, best.start) : null;
}

// ---- §3.6 A job longer than the day

/** The most copies of this job that some eligible machine finishes in one full working day. */
export function maxCopiesInOneDay(job: JobSpec, ctx: ScheduleContext): number {
  let most = 0;
  for (const m of ctx.machines) {
    if (!isStaticEligible(job, m)) continue;
    const printMinutes = dayMinutes(ctx) - job.models * m.setupMinutesPerModel;
    if (printMinutes <= 0) continue;
    most = Math.max(most, floorDiv(printMinutes * m.speedPerHour, 60 * job.models * job.pagesPerModel));
  }
  return most;
}
