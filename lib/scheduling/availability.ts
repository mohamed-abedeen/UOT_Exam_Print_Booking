// What a request for (job, date, hour) gets, and the check of an accepted suggestion (contracts §3.5, §4).
// Pure: the caller loads `ctx` (lib/scheduling/load.ts).
import {
  dayRefusal,
  durationMinutes,
  isFreeOn,
  isStaticEligible,
  maxCopiesInOneDay,
  nearestFreeStart,
  placeInHour,
  workingWindow,
} from "./schedule";
import { addMinutes, ceilToGrid, localDate, SLOT_MINUTES } from "./time";
import type { JobSpec, Placement, Refusal, ScheduleContext } from "./types";

export type Availability =
  | { kind: "exact"; placement: Placement }
  | { kind: "suggestion"; placement: Placement; reason: Refusal }
  | { kind: "none"; reason: Refusal; maxCopies?: number }; // maxCopies comes with 'too_long'

export function availabilityFor(job: JobSpec, date: string, hour: number, ctx: ScheduleContext): Availability {
  const placed = placeInHour(job, date, hour, ctx);
  if (typeof placed !== "string") return { kind: "exact", placement: placed };
  if (placed === "no_machine") return { kind: "none", reason: placed };
  if (placed === "too_long") return { kind: "none", reason: placed, maxCopies: maxCopiesInOneDay(job, ctx) };
  const nearest = nearestFreeStart(job, date, hour, ctx);
  if (typeof nearest === "string") return { kind: "none", reason: nearest };
  return { kind: "suggestion", placement: nearest, reason: placed };
}

/**
 * An accepted suggestion, checked again against the current `ctx`. Only the machine and the start are taken from
 * the client; the end is computed here. Null = no longer bookable (the caller answers `slot_taken`).
 */
export function checkAccepted(
  job: JobSpec,
  accept: { machineId: number; startsAt: Date },
  ctx: ScheduleContext,
): Placement | null {
  const machine = ctx.machines.find((m) => m.id === accept.machineId);
  if (!machine || !isStaticEligible(job, machine)) return null;

  const start = accept.startsAt;
  if (start.getTime() % (SLOT_MINUTES * 60_000) !== 0 || start.getTime() < ceilToGrid(ctx.now).getTime()) return null;

  // Inside one open working day. This also covers 'too_long': a job that fits before the close fits in a day.
  const date = localDate(start);
  const window = workingWindow(date, ctx);
  const end = addMinutes(start, durationMinutes(job, machine));
  if (!window || start.getTime() < window.open.getTime() || end.getTime() > window.close.getTime()) return null;

  if (dayRefusal(job, date, ctx) !== null) return null;
  if (!isFreeOn(machine, { start, end }, ctx)) return null;
  return { machineId: machine.id, startsAt: start, endsAt: end };
}
