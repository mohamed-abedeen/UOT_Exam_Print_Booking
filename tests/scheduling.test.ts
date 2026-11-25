// Step 1.3: the scheduling core (contracts §3.1–3.6). Pure functions, no database.
// Machines M1–M4, the 09:00–15:00 window and the worked examples are the ones in the contract.
import { describe, expect, it } from "vitest";
import {
  dayRefusal,
  durationMinutes,
  eligibleMachines,
  freeStarts,
  isFreeOn,
  isStaticEligible,
  latestFreeStart,
  maxCopiesInOneDay,
  nearestFreeStart,
  placeInHour,
  quantities,
  tierGroup,
  workingWindow,
} from "@/lib/scheduling/schedule";
import { addDays, atMinutes, ceilToGrid, localDate, minutesOfDay, weekdayOf } from "@/lib/scheduling/time";
import type { Busy, JobSpec, Machine, Placement, ScheduleContext, Settings, Sides } from "@/lib/scheduling/types";

const THURSDAY = "2026-11-26";
const FRIDAY = "2026-11-27";
const SATURDAY = "2026-11-28";
const SUNDAY = "2026-11-29";
const MONDAY = "2026-11-30";

function machine(id: number, over: Partial<Machine>): Machine {
  return {
    id,
    minSheets: 1,
    maxSheets: null,
    supportsDuplex: true,
    speedPerHour: 3000,
    setupMinutesPerModel: 5,
    priority: 1,
    archivedAt: null,
    ...over,
  };
}
const M1 = machine(1, { minSheets: 1, maxSheets: 400, speedPerHour: 3000 });
const M2 = machine(2, { minSheets: 401, maxSheets: 800, speedPerHour: 4200 });
const M3 = machine(3, { minSheets: 801, supportsDuplex: false, speedPerHour: 7200, setupMinutesPerModel: 10 });
const M4 = machine(4, { minSheets: 801, speedPerHour: 6000, priority: 2 });

const SETTINGS: Settings = {
  workStart: "09:00",
  workEnd: "15:00",
  workingWeekdays: [0, 1, 2, 3, 4],
  largeJobThreshold: 6000,
  largeJobsPerDay: 2,
  editDeadlineMinutes: 60,
  delayDeadlineMinutes: 60,
  suggestionSearchDays: 14,
  partWarnPercent: 90,
};

/** An instant from a Tripoli date and 'HH:MM'. */
function t(date: string, time: string): Date {
  return atMinutes(date, minutesOfDay(time));
}
function busy(machineId: number, date: string, from: string, to: string | null, bookingId?: number): Busy {
  return { machineId, start: t(date, from), end: to === null ? null : t(date, to), bookingId };
}
function job(models: number, pagesPerModel: number, copies: number, sides: Sides = "single"): JobSpec {
  return { models, pagesPerModel, copies, sides };
}
function makeCtx(over: Partial<ScheduleContext> = {}): ScheduleContext {
  return {
    now: t(SUNDAY, "08:00"),
    collegeId: 1,
    settings: SETTINGS,
    holidays: new Set(),
    saturdayApprovals: [],
    machines: [M1, M2, M3, M4],
    busy: [],
    largeJobsByDate: new Map(),
    loadMinutes: () => 0,
    ...over,
  };
}
function placed(machineId: number, date: string, from: string, to: string): Placement {
  return { machineId, startsAt: t(date, from), endsAt: t(date, to) };
}
const ids = (machines: Machine[]) => machines.map((m) => m.id);
const times = (starts: Date[]) => starts.map((s) => s.toISOString());

describe("time helpers", () => {
  it("places a Tripoli wall time two hours ahead of UTC", () => {
    expect(t(SUNDAY, "09:00").toISOString()).toBe("2026-11-29T07:00:00.000Z");
  });

  it("gives the business date of an instant, also just after local midnight", () => {
    expect(localDate(new Date("2026-11-28T22:30:00Z"))).toBe(SUNDAY);
    expect(localDate(new Date("2026-11-28T21:59:00Z"))).toBe(SATURDAY);
  });

  it("knows weekdays and steps over a month end", () => {
    expect(weekdayOf(SUNDAY)).toBe(0);
    expect(weekdayOf(FRIDAY)).toBe(5);
    expect(weekdayOf(SATURDAY)).toBe(6);
    expect(addDays(MONDAY, 1)).toBe("2026-12-01");
  });

  it("steps over a year end", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(localDate(new Date("2026-12-31T22:00:00Z"))).toBe("2027-01-01");
  });

  it("rounds up to the 10-minute grid and keeps an instant already on it", () => {
    expect(ceilToGrid(t(SUNDAY, "10:21"))).toEqual(t(SUNDAY, "10:30"));
    expect(ceilToGrid(t(SUNDAY, "10:30"))).toEqual(t(SUNDAY, "10:30"));
    expect(ceilToGrid(new Date(t(SUNDAY, "10:30").getTime() + 1))).toEqual(t(SUNDAY, "10:40"));
  });
});

describe("quantities (§3.1)", () => {
  it.each([
    { name: "duplex, even pages", j: job(3, 4, 200, "duplex"), impressions: 2400, sheets: 1200 },
    { name: "single", j: job(3, 4, 200), impressions: 2400, sheets: 2400 },
    { name: "duplex, odd pages", j: job(2, 5, 100, "duplex"), impressions: 1000, sheets: 600 },
    { name: "duplex, one page", j: job(1, 1, 30, "duplex"), impressions: 30, sheets: 30 },
  ])("$name", ({ j, impressions, sheets }) => {
    expect(quantities(j)).toEqual({ impressions, sheets });
  });
});

describe("durationMinutes (§3.2)", () => {
  it.each([
    { name: "2,400 on M4: 39 → 40", j: job(3, 4, 200), m: M4, minutes: 40 },
    { name: "300 on M1: 11 → 20", j: job(1, 2, 150), m: M1, minutes: 20 },
    { name: "300 on M2: 9.29 → 10", j: job(1, 2, 150), m: M2, minutes: 10 },
    { name: "500 on M3: 24.17 → 30", j: job(2, 5, 50), m: M3, minutes: 30 },
  ])("$name", ({ j, m, minutes }) => {
    expect(durationMinutes(j, m)).toBe(minutes);
  });

  it("does not round an exact multiple of 10 up (the floating-point trap)", () => {
    const m = machine(9, { speedPerHour: 600, setupMinutesPerModel: 0 });
    expect(durationMinutes(job(1, 1, 2500), m)).toBe(250);
    expect(durationMinutes(job(1, 1, 2501), m)).toBe(260);
  });

  it("is never below one slot", () => {
    expect(durationMinutes(job(1, 1, 1), machine(9, { speedPerHour: 6000, setupMinutesPerModel: 0 }))).toBe(10);
  });

  it("is the same for single and duplex: impressions drive it, not sheets", () => {
    expect(durationMinutes(job(3, 4, 200, "duplex"), M4)).toBe(durationMinutes(job(3, 4, 200), M4));
  });
});

describe("eligible machines and their order (§3.3)", () => {
  it.each([
    { impressions: 400, single: [1, 2, 3, 4], duplex: [1, 2, 4] },
    { impressions: 401, single: [2, 3, 4], duplex: [2, 4] },
    { impressions: 800, single: [2, 3, 4], duplex: [2, 4] },
    { impressions: 801, single: [3, 4], duplex: [4] },
  ])("tier edge $impressions", ({ impressions, single, duplex }) => {
    const ctx = makeCtx();
    expect(ids(eligibleMachines(job(1, 1, impressions), SUNDAY, ctx))).toEqual(single);
    expect(ids(eligibleMachines(job(1, 1, impressions, "duplex"), SUNDAY, ctx))).toEqual(duplex);
  });

  it("tierGroup is 0 inside the range and the lower bound of a larger machine otherwise", () => {
    expect(tierGroup(M1, 400)).toBe(0);
    expect(tierGroup(M2, 400)).toBe(401);
    expect(tierGroup(M2, 401)).toBe(0);
    expect(tierGroup(M3, 800)).toBe(801);
    expect(tierGroup(M3, 801)).toBe(0);
    // A job above the range still counts as "inside": isStaticEligible is what keeps it off the machine.
    expect(tierGroup(M1, 5000)).toBe(0);
  });

  it("an archived machine is never eligible", () => {
    expect(isStaticEligible(job(1, 1, 100), { ...M1, archivedAt: t(SUNDAY, "08:00") })).toBe(false);
  });

  it("a smaller machine never takes a bigger job, a larger one takes a smaller job", () => {
    expect(isStaticEligible(job(1, 1, 401), M1)).toBe(false);
    expect(isStaticEligible(job(1, 1, 1), M4)).toBe(true);
  });

  it("orders by priority, then the day's load, then id inside one tier group", () => {
    const a = machine(11, { minSheets: 801, priority: 2 });
    const b = machine(12, { minSheets: 801, priority: 1 });
    const c = machine(13, { minSheets: 801, priority: 1 });
    const d = machine(14, { minSheets: 801, priority: 1 });
    const load: Record<number, number> = { 11: 0, 12: 120, 13: 30, 14: 30 };
    const ctx = makeCtx({ machines: [a, b, c, d], loadMinutes: (id) => load[id] });
    expect(ids(eligibleMachines(job(1, 1, 900), SUNDAY, ctx))).toEqual([13, 14, 12, 11]);
  });

  it("asks for the load of the given date", () => {
    const a = machine(11, {});
    const b = machine(12, {});
    const ctx = makeCtx({
      machines: [a, b],
      loadMinutes: (id, date) => (date === SUNDAY ? (id === 11 ? 60 : 0) : id === 11 ? 0 : 60),
    });
    expect(ids(eligibleMachines(job(1, 1, 10), SUNDAY, ctx))).toEqual([12, 11]);
    expect(ids(eligibleMachines(job(1, 1, 10), MONDAY, ctx))).toEqual([11, 12]);
  });
});

describe("isFreeOn (§3.3)", () => {
  const slot = { start: t(SUNDAY, "10:00"), end: t(SUNDAY, "10:20") };

  it("treats intervals as half-open: touching ends do not overlap", () => {
    const ctx = makeCtx({ busy: [busy(1, SUNDAY, "09:30", "10:00"), busy(1, SUNDAY, "10:20", "11:00")] });
    expect(isFreeOn(M1, slot, ctx)).toBe(true);
  });

  it("is blocked by any overlap on the same machine only", () => {
    const ctx = makeCtx({ busy: [busy(1, SUNDAY, "10:10", "10:30")] });
    expect(isFreeOn(M1, slot, ctx)).toBe(false);
    expect(isFreeOn(M2, slot, ctx)).toBe(true);
  });

  it("a stop with no end blocks everything from its start on", () => {
    const ctx = makeCtx({ busy: [busy(1, SUNDAY, "10:10", null)] });
    expect(isFreeOn(M1, slot, ctx)).toBe(false);
    expect(isFreeOn(M1, { start: t(MONDAY, "09:00"), end: t(MONDAY, "09:20") }, ctx)).toBe(false);
    expect(isFreeOn(M1, { start: t(SUNDAY, "09:00"), end: t(SUNDAY, "10:10") }, ctx)).toBe(true);
  });

  it("skips the booking named by ignoreBookingId, never a maintenance row", () => {
    const rows = [busy(1, SUNDAY, "10:00", "10:20", 77)];
    expect(isFreeOn(M1, slot, makeCtx({ busy: rows }))).toBe(false);
    expect(isFreeOn(M1, slot, makeCtx({ busy: rows, ignoreBookingId: 77 }))).toBe(true);
    expect(isFreeOn(M1, slot, makeCtx({ busy: rows, ignoreBookingId: 78 }))).toBe(false);
    const maintenance = [busy(1, SUNDAY, "10:00", "10:20")];
    expect(isFreeOn(M1, slot, makeCtx({ busy: maintenance }))).toBe(false);
    expect(isFreeOn(M1, slot, makeCtx({ busy: maintenance, ignoreBookingId: 77 }))).toBe(false);
  });
});

describe("working calendar (§3.4)", () => {
  const small = job(1, 2, 150);

  it("opens a working weekday for the set hours", () => {
    expect(workingWindow(SUNDAY, makeCtx())).toEqual({ open: t(SUNDAY, "09:00"), close: t(SUNDAY, "15:00") });
    expect(workingWindow(THURSDAY, makeCtx())).not.toBeNull();
  });

  it("closes Friday and Saturday", () => {
    expect(workingWindow(FRIDAY, makeCtx())).toBeNull();
    expect(workingWindow(SATURDAY, makeCtx())).toBeNull();
    expect(dayRefusal(small, FRIDAY, makeCtx())).toBe("day_closed");
  });

  it("closes a holiday on a working weekday for everyone", () => {
    const ctx = makeCtx({ holidays: new Set([SUNDAY]) });
    expect(workingWindow(SUNDAY, ctx)).toBeNull();
    expect(dayRefusal(small, SUNDAY, ctx)).toBe("day_closed");
    expect(dayRefusal(small, MONDAY, ctx)).toBeNull();
  });

  it("follows the working_weekdays setting", () => {
    const ctx = makeCtx({ settings: { ...SETTINGS, workingWeekdays: [6] } });
    expect(workingWindow(SATURDAY, ctx)).not.toBeNull();
    expect(workingWindow(SUNDAY, ctx)).toBeNull();
  });

  describe("large-job rule (threshold 6,000, limit 2)", () => {
    const full = makeCtx({ largeJobsByDate: new Map([[SUNDAY, 2]]) });

    it("a job of exactly 6,000 is not large", () => {
      expect(dayRefusal(job(1, 1, 6000), SUNDAY, full)).toBeNull();
    });

    it("a job of 6,001 is refused on a day that already holds two large jobs", () => {
      expect(dayRefusal(job(1, 1, 6001), SUNDAY, full)).toBe("large_job_limit");
    });

    it("a large job is allowed while the day holds fewer than the limit, and on another day", () => {
      expect(dayRefusal(job(1, 1, 6001), SUNDAY, makeCtx({ largeJobsByDate: new Map([[SUNDAY, 1]]) }))).toBeNull();
      expect(dayRefusal(job(1, 1, 6001), MONDAY, full)).toBeNull();
    });

    it("a limit of 0 refuses every large job", () => {
      const ctx = makeCtx({ settings: { ...SETTINGS, largeJobsPerDay: 0 } });
      expect(dayRefusal(job(1, 1, 6001), SUNDAY, ctx)).toBe("large_job_limit");
      expect(dayRefusal(job(1, 1, 6000), SUNDAY, ctx)).toBeNull();
    });
  });

  describe("Saturday approval (college A: 5,000 approved, 3,800 used)", () => {
    const collegeA = makeCtx({
      saturdayApprovals: [{ date: SATURDAY, approvedQuantity: 5000, usedImpressions: 3800 }],
    });

    it("opens the date for the approved college", () => {
      expect(workingWindow(SATURDAY, collegeA)).toEqual({ open: t(SATURDAY, "09:00"), close: t(SATURDAY, "15:00") });
    });

    it("allows a job inside the quota, up to exactly the approved quantity", () => {
      expect(dayRefusal(job(1, 1, 1000), SATURDAY, collegeA)).toBeNull();
      expect(dayRefusal(job(1, 1, 1200), SATURDAY, collegeA)).toBeNull();
    });

    it("refuses a job that passes the quota", () => {
      expect(dayRefusal(job(1, 1, 1500), SATURDAY, collegeA)).toBe("saturday_quota");
      expect(dayRefusal(job(1, 1, 1201), SATURDAY, collegeA)).toBe("saturday_quota");
    });

    it("stays closed for a college without an approval, and on another Saturday", () => {
      expect(dayRefusal(job(1, 1, 1000), SATURDAY, makeCtx())).toBe("day_closed");
      expect(dayRefusal(job(1, 1, 1000), addDays(SATURDAY, 7), collegeA)).toBe("day_closed");
    });

    it("a holiday closes an approved Saturday too", () => {
      const ctx = makeCtx({ ...collegeA, holidays: new Set([SATURDAY]) });
      expect(dayRefusal(job(1, 1, 1000), SATURDAY, ctx)).toBe("day_closed");
    });

    it("the quota does not apply on a normal working day", () => {
      const ctx = makeCtx({ saturdayApprovals: [{ date: SUNDAY, approvedQuantity: 100, usedImpressions: 100 }] });
      expect(dayRefusal(job(1, 1, 1000), SUNDAY, ctx)).toBeNull();
    });

    it("checks the large-job limit before the quota", () => {
      const ctx = makeCtx({ ...collegeA, largeJobsByDate: new Map([[SATURDAY, 2]]) });
      expect(dayRefusal(job(1, 1, 6001), SATURDAY, ctx)).toBe("large_job_limit");
    });
  });
});

describe("freeStarts (§3.5)", () => {
  const small = job(1, 2, 150); // 300 impressions: 20 minutes on M1, 10 on M2

  it("lists every grid start from opening to the last one that still ends by closing", () => {
    const starts = freeStarts(small, M1, MONDAY, makeCtx());
    expect(starts).toHaveLength(35); // 09:00 … 14:40
    expect(starts[0]).toEqual(t(MONDAY, "09:00"));
    expect(starts[1]).toEqual(t(MONDAY, "09:10"));
    expect(starts.at(-1)).toEqual(t(MONDAY, "14:40"));
    expect(freeStarts(small, M2, MONDAY, makeCtx()).at(-1)).toEqual(t(MONDAY, "14:50"));
  });

  it("starts no earlier than now rounded up to the grid", () => {
    expect(freeStarts(small, M1, SUNDAY, makeCtx({ now: t(SUNDAY, "10:21") }))[0]).toEqual(t(SUNDAY, "10:30"));
    expect(freeStarts(small, M1, SUNDAY, makeCtx({ now: t(SUNDAY, "10:30") }))[0]).toEqual(t(SUNDAY, "10:30"));
  });

  it("keeps only starts that are not past and still end by closing", () => {
    const late = makeCtx({ now: t(SUNDAY, "14:45") });
    expect(freeStarts(small, M1, SUNDAY, late)).toEqual([]);
    expect(times(freeStarts(small, M2, SUNDAY, late))).toEqual(times([t(SUNDAY, "14:50")]));
    expect(freeStarts(small, M1, THURSDAY, makeCtx())).toEqual([]);
  });

  it("leaves out every start whose interval would touch a busy row", () => {
    const ctx = makeCtx({ busy: [busy(1, SUNDAY, "09:30", "10:40"), busy(1, SUNDAY, "10:50", "11:30")] });
    const starts = times(freeStarts(small, M1, SUNDAY, ctx));
    expect(starts.slice(0, 3)).toEqual(times([t(SUNDAY, "09:00"), t(SUNDAY, "09:10"), t(SUNDAY, "11:30")]));
  });

  it("is empty on a refused day and for a machine that is not eligible", () => {
    expect(freeStarts(small, M1, FRIDAY, makeCtx())).toEqual([]);
    expect(freeStarts(small, M1, MONDAY, makeCtx({ holidays: new Set([MONDAY]) }))).toEqual([]);
    expect(freeStarts(job(1, 1, 401), M1, MONDAY, makeCtx())).toEqual([]);
    expect(freeStarts(job(1, 1, 6001), M3, MONDAY, makeCtx({ largeJobsByDate: new Map([[MONDAY, 2]]) }))).toEqual([]);
  });

  it("is empty when the job is longer than the working day", () => {
    expect(freeStarts(job(6, 8, 1200, "duplex"), M4, MONDAY, makeCtx())).toEqual([]);
  });
});

describe("placeInHour (§3.5)", () => {
  const small = job(1, 2, 150);
  const m1Busy = [busy(1, SUNDAY, "09:30", "10:40"), busy(1, SUNDAY, "10:50", "11:30")];

  it("takes the in-range machine at the top of a free hour", () => {
    expect(placeInHour(small, SUNDAY, 10, makeCtx())).toEqual(placed(1, SUNDAY, "10:00", "10:20"));
  });

  it("example A: M1 has no start in the hour, the next tier takes it at 10:30", () => {
    const ctx = makeCtx({ busy: [...m1Busy, busy(2, SUNDAY, "10:00", "10:30")] });
    // M3 and M4 are free at 10:00, but the nearer tier (M2) comes first.
    expect(placeInHour(small, SUNDAY, 10, ctx)).toEqual(placed(2, SUNDAY, "10:30", "10:40"));
  });

  it("example B: a full hour is refused", () => {
    const ctx = makeCtx({
      busy: [...m1Busy, ...[2, 3, 4].map((id) => busy(id, SUNDAY, "09:00", "11:00"))],
    });
    expect(placeInHour(small, SUNDAY, 10, ctx)).toBe("hour_full");
  });

  it("an in-range machine late in the hour beats a larger machine at its start", () => {
    const ctx = makeCtx({ busy: [busy(1, SUNDAY, "09:00", "10:50")] });
    expect(placeInHour(small, SUNDAY, 10, ctx)).toEqual(placed(1, SUNDAY, "10:50", "11:10"));
  });

  it("the end may run past the hour", () => {
    const ctx = makeCtx({ machines: [M3], busy: [busy(3, SUNDAY, "09:00", "10:40")] });
    // M3: 30 + 20 = 50 minutes
    expect(placeInHour(job(3, 4, 200), SUNDAY, 10, ctx)).toEqual(placed(3, SUNDAY, "10:40", "11:30"));
  });

  it("the end never runs past closing", () => {
    const long = job(6, 8, 600, "duplex"); // 320 minutes on M4, the only eligible machine
    expect(placeInHour(long, MONDAY, 9, makeCtx())).toEqual(placed(4, MONDAY, "09:00", "14:20"));
    expect(placeInHour(long, MONDAY, 10, makeCtx())).toBe("hour_full");
    expect(placeInHour(small, MONDAY, 14, makeCtx({ machines: [M1] }))).toEqual(placed(1, MONDAY, "14:00", "14:20"));
    expect(placeInHour(small, MONDAY, 14, makeCtx({ machines: [M1], busy: [busy(1, MONDAY, "14:00", "14:50")] }))).toBe(
      "hour_full", // 14:50 would end at 15:10
    );
  });

  it("at the same start in one tier group: priority, then load, then id", () => {
    const big = job(1, 1, 900);
    expect(placeInHour(big, SUNDAY, 10, makeCtx())).toMatchObject({ machineId: 3 });
    const twins = [machine(11, { minSheets: 801 }), machine(12, { minSheets: 801 })];
    expect(placeInHour(big, SUNDAY, 10, makeCtx({ machines: twins }))).toMatchObject({ machineId: 11 });
    const loaded = makeCtx({ machines: twins, loadMinutes: (id) => (id === 11 ? 60 : 0) });
    expect(placeInHour(big, SUNDAY, 10, loaded)).toMatchObject({ machineId: 12 });
  });

  it("in one tier group the earlier start wins over the better priority", () => {
    const ctx = makeCtx({ busy: [busy(3, SUNDAY, "10:00", "10:10")] });
    expect(placeInHour(job(1, 1, 900), SUNDAY, 10, ctx)).toMatchObject({ machineId: 4, startsAt: t(SUNDAY, "10:00") });
  });

  it("skips starts already past inside the current hour", () => {
    const ctx = makeCtx({ now: t(SUNDAY, "10:21") });
    expect(placeInHour(small, SUNDAY, 10, ctx)).toEqual(placed(1, SUNDAY, "10:30", "10:50"));
  });

  describe("refusals, in order", () => {
    const tooLong = job(6, 8, 1200, "duplex");

    it("past: a date before today, or an hour with no start left", () => {
      expect(placeInHour(small, THURSDAY, 10, makeCtx())).toBe("past");
      expect(placeInHour(small, SUNDAY, 10, makeCtx({ now: t(SUNDAY, "10:51") }))).toBe("past");
      expect(placeInHour(small, SUNDAY, 10, makeCtx({ now: t(SUNDAY, "10:50") }))).not.toBe("past");
    });

    it("past comes before no_machine, too_long and day_closed", () => {
      expect(placeInHour(tooLong, FRIDAY, 10, makeCtx({ machines: [], now: t(SUNDAY, "08:00") }))).toBe("past");
    });

    it("no_machine: nothing can take the job", () => {
      expect(placeInHour(job(1, 1, 801, "duplex"), SUNDAY, 10, makeCtx({ machines: [M1, M2, M3] }))).toBe("no_machine");
      const archived = { ...M4, archivedAt: t(THURSDAY, "09:00") };
      expect(placeInHour(job(1, 1, 801, "duplex"), SUNDAY, 10, makeCtx({ machines: [M1, M2, M3, archived] }))).toBe(
        "no_machine",
      );
    });

    it("no_machine comes before too_long and day_closed", () => {
      expect(placeInHour(tooLong, addDays(FRIDAY, 7), 10, makeCtx({ machines: [M1, M2, M3] }))).toBe("no_machine");
    });

    it("too_long: the job fits in no working day, also asked for a closed day", () => {
      expect(placeInHour(tooLong, SUNDAY, 9, makeCtx())).toBe("too_long");
      expect(placeInHour(tooLong, addDays(FRIDAY, 7), 9, makeCtx())).toBe("too_long");
    });

    it("not too_long while one eligible machine still fits it in a day", () => {
      // 1 × 1 × 30,000 single: M3 needs 260 minutes, the slow machine 3,010.
      const slowAndFast = [M3, machine(21, { minSheets: 801, speedPerHour: 600 })];
      expect(placeInHour(job(1, 1, 30000), SUNDAY, 9, makeCtx({ machines: slowAndFast }))).toEqual(
        placed(3, SUNDAY, "09:00", "13:20"),
      );
    });

    it("day_closed: Friday, a holiday, or an hour outside the working hours", () => {
      expect(placeInHour(small, addDays(FRIDAY, 7), 10, makeCtx())).toBe("day_closed");
      expect(placeInHour(small, MONDAY, 10, makeCtx({ holidays: new Set([MONDAY]) }))).toBe("day_closed");
      expect(placeInHour(small, MONDAY, 8, makeCtx())).toBe("day_closed");
      expect(placeInHour(small, MONDAY, 15, makeCtx())).toBe("day_closed");
      expect(placeInHour(small, MONDAY, 14, makeCtx())).not.toBe("day_closed");
    });

    it("an hour cut by the opening time is open from the opening time", () => {
      const ctx = makeCtx({ settings: { ...SETTINGS, workStart: "08:30" } });
      expect(placeInHour(small, MONDAY, 8, ctx)).toEqual(placed(1, MONDAY, "08:30", "08:50"));
    });

    it("day_closed comes before large_job_limit", () => {
      const ctx = makeCtx({ holidays: new Set([MONDAY]), largeJobsByDate: new Map([[MONDAY, 2]]) });
      expect(placeInHour(job(1, 1, 6001), MONDAY, 10, ctx)).toBe("day_closed");
    });

    it("large_job_limit, then saturday_quota, then hour_full", () => {
      const approval = [{ date: addDays(SATURDAY, 7), approvedQuantity: 5000, usedImpressions: 3800 }];
      const saturday = addDays(SATURDAY, 7);
      const allBusy = [1, 2, 3, 4].map((id) => busy(id, saturday, "09:00", "15:00"));
      expect(
        placeInHour(job(1, 1, 6001), saturday, 10, makeCtx({
          saturdayApprovals: approval,
          largeJobsByDate: new Map([[saturday, 2]]),
          busy: allBusy,
        })),
      ).toBe("large_job_limit");
      expect(placeInHour(job(1, 1, 1500), saturday, 10, makeCtx({ saturdayApprovals: approval, busy: allBusy }))).toBe(
        "saturday_quota",
      );
      expect(placeInHour(job(1, 1, 1000), saturday, 10, makeCtx({ saturdayApprovals: approval, busy: allBusy }))).toBe(
        "hour_full",
      );
      expect(placeInHour(job(1, 1, 1000), saturday, 10, makeCtx({ saturdayApprovals: approval }))).toEqual(
        placed(3, saturday, "10:00", "10:20"), // 1,000 is above M1 and M2 → M3 (priority 1)
      );
    });
  });
});

describe("nearestFreeStart (§3.5)", () => {
  const small = job(1, 2, 150);
  const m1Busy = [busy(1, SUNDAY, "09:30", "10:40"), busy(1, SUNDAY, "10:50", "11:30")];
  const exampleB = () =>
    makeCtx({ busy: [...m1Busy, ...[2, 3, 4].map((id) => busy(id, SUNDAY, "09:00", "11:00"))] });

  it("example B: the nearest start to 10:00 is M1 at 09:10", () => {
    expect(nearestFreeStart(small, SUNDAY, 10, exampleB())).toEqual(placed(1, SUNDAY, "09:10", "09:30"));
  });

  it("at the same distance the nearer tier wins, before the earlier start", () => {
    // Without 09:10: M1 09:00 and M2/M3/M4 11:00 are all 60 minutes away → M1 (in range).
    const ctx = exampleB();
    ctx.busy.push(busy(1, SUNDAY, "09:20", "09:30"));
    expect(nearestFreeStart(small, SUNDAY, 10, ctx)).toEqual(placed(1, SUNDAY, "09:00", "09:20"));
    // Without M1 at all: M2, M3 and M4 at 11:00 → M2 (tier group 401 before 801).
    ctx.busy.push(busy(1, SUNDAY, "09:00", "09:20"));
    expect(nearestFreeStart(small, SUNDAY, 10, ctx)).toEqual(placed(2, SUNDAY, "11:00", "11:10"));
  });

  it("at the same distance the nearer tier wins even with the later start", () => {
    // M1 (in range) is free only at 11:00, M2 (larger) only at 09:00: both 60 minutes from 10:00.
    const ctx = makeCtx({
      machines: [M1, M2],
      busy: [busy(1, SUNDAY, "09:00", "11:00"), busy(1, SUNDAY, "11:20", "15:00"), busy(2, SUNDAY, "09:10", "15:00")],
    });
    expect(nearestFreeStart(small, SUNDAY, 10, ctx)).toEqual(placed(1, SUNDAY, "11:00", "11:20"));
  });

  it("at the same distance, tier and start: priority, then load, then id", () => {
    const twins = [machine(11, {}), machine(12, {})];
    expect(nearestFreeStart(small, SUNDAY, 10, makeCtx({ machines: twins }))).toMatchObject({ machineId: 11 });
    const loaded = makeCtx({ machines: twins, loadMinutes: (id) => (id === 11 ? 60 : 0) });
    expect(nearestFreeStart(small, SUNDAY, 10, loaded)).toMatchObject({ machineId: 12 });
    const preferred = makeCtx({ machines: [twins[0], { ...twins[1], priority: 0 }] });
    expect(nearestFreeStart(small, SUNDAY, 10, preferred)).toMatchObject({ machineId: 12 });
  });

  it("uses the load of the suggested day, not of the requested one", () => {
    const ctx = makeCtx({
      machines: [machine(11, {}), machine(12, {})],
      holidays: new Set([SUNDAY]),
      loadMinutes: (id, date) => (date === SUNDAY ? (id === 11 ? 60 : 0) : id === 11 ? 0 : 60),
    });
    expect(nearestFreeStart(small, SUNDAY, 10, ctx)).toMatchObject({ machineId: 11, startsAt: t(MONDAY, "10:00") });
  });

  it("at the same distance and tier the earlier start wins", () => {
    const ctx = makeCtx({ machines: [M1], busy: [busy(1, SUNDAY, "09:40", "10:40")] });
    // 09:20 (ends 09:40) and 10:40 are both 40 minutes from 10:00.
    expect(nearestFreeStart(small, SUNDAY, 10, ctx)).toEqual(placed(1, SUNDAY, "09:20", "09:40"));
  });

  it("example C: a closed day gives the nearest start to that hour on the next open day", () => {
    const friday = addDays(FRIDAY, 7); // Friday, then Saturday, both closed
    expect(nearestFreeStart(small, friday, 10, makeCtx())).toEqual(placed(1, addDays(friday, 2), "10:00", "10:20"));
  });

  it("skips a holiday", () => {
    const ctx = makeCtx({ holidays: new Set([MONDAY]) });
    expect(nearestFreeStart(small, MONDAY, 11, ctx)).toEqual(placed(1, addDays(MONDAY, 1), "11:00", "11:20"));
  });

  it("a large job moves to the next day when the day's large-job limit is reached", () => {
    const ctx = makeCtx({ largeJobsByDate: new Map([[SUNDAY, 2]]) });
    expect(nearestFreeStart(job(1, 1, 6001), SUNDAY, 9, ctx)).toEqual(placed(3, MONDAY, "09:00", "10:10"));
  });

  it("skips a Saturday whose quota the job would pass", () => {
    const ctx = makeCtx({
      now: t(FRIDAY, "08:00"),
      saturdayApprovals: [{ date: SATURDAY, approvedQuantity: 5000, usedImpressions: 3800 }],
    });
    expect(nearestFreeStart(job(1, 1, 1000), SATURDAY, 10, ctx)).toMatchObject({ startsAt: t(SATURDAY, "10:00") });
    expect(nearestFreeStart(job(1, 1, 1500), SATURDAY, 10, ctx)).toMatchObject({ startsAt: t(SUNDAY, "10:00") });
  });

  it("the first day with any free start wins, even far from the hour", () => {
    const ctx = makeCtx({ machines: [M1], busy: [busy(1, SUNDAY, "09:00", "14:40")] });
    expect(nearestFreeStart(small, SUNDAY, 9, ctx)).toEqual(placed(1, SUNDAY, "14:40", "15:00"));
  });

  it("never suggests a start before now, and searches from today for a past date", () => {
    const ctx = makeCtx({ now: t(SUNDAY, "12:05") });
    expect(nearestFreeStart(small, SUNDAY, 9, ctx)).toEqual(placed(1, SUNDAY, "12:10", "12:30"));
    expect(nearestFreeStart(small, THURSDAY, 9, ctx)).toEqual(placed(1, SUNDAY, "12:10", "12:30"));
  });

  it("looks suggestion_search_days ahead, that day included, then gives up", () => {
    const block = (days: number) =>
      Array.from({ length: days }, (_, i) => busy(1, addDays(SUNDAY, i), "09:00", "15:00"));
    const base = { machines: [M1], settings: { ...SETTINGS, suggestionSearchDays: 2 } };
    expect(nearestFreeStart(small, SUNDAY, 10, makeCtx({ ...base, busy: block(2) }))).toEqual(
      placed(1, addDays(SUNDAY, 2), "10:00", "10:20"),
    );
    expect(nearestFreeStart(small, SUNDAY, 10, makeCtx({ ...base, busy: block(3) }))).toBe("no_free_slot");
  });

  it("gives up when no machine has room in the whole search range", () => {
    const ctx = makeCtx({ busy: [1, 2, 3, 4].map((id) => busy(id, SUNDAY, "09:00", null)) });
    expect(nearestFreeStart(small, SUNDAY, 10, ctx)).toBe("no_free_slot");
  });
});

describe("a job longer than the day (§3.6)", () => {
  const entered = job(6, 8, 1200, "duplex"); // 57,600 impressions, only M4 is eligible
  const half = job(6, 8, 600, "duplex"); // 28,800 impressions, 14,400 sheets, 320 minutes on M4

  it("the contract example: 610 minutes do not fit in 360, at most 687 copies do", () => {
    expect(ids(eligibleMachines(entered, SUNDAY, makeCtx()))).toEqual([4]);
    expect(durationMinutes(entered, M4)).toBe(610);
    expect(maxCopiesInOneDay(entered, makeCtx())).toBe(687);
    expect(placeInHour(entered, SUNDAY, 9, makeCtx())).toBe("too_long");
  });

  it("maxCopies is exactly the edge: 687 copies fit in a day, 688 do not", () => {
    expect(durationMinutes({ ...entered, copies: 687 }, M4)).toBe(360);
    expect(placeInHour({ ...entered, copies: 687 }, SUNDAY, 9, makeCtx())).toEqual(placed(4, SUNDAY, "09:00", "15:00"));
    expect(durationMinutes({ ...entered, copies: 688 }, M4)).toBe(370);
    expect(placeInHour({ ...entered, copies: 688 }, SUNDAY, 9, makeCtx())).toBe("too_long");
  });

  it("agrees with the duration rule over a sweep of jobs", () => {
    for (const models of [1, 3, 7]) {
      for (const pages of [1, 5, 16]) {
        for (const sides of ["single", "duplex"] as const) {
          const base = job(models, pages, 1, sides);
          const ctx = makeCtx();
          const max = maxCopiesInOneDay(base, ctx);
          const fits = (copies: number) =>
            ctx.machines.some(
              (m) => isStaticEligible(base, m) && durationMinutes({ ...base, copies }, m) <= 360,
            );
          if (max > 0) expect(fits(max)).toBe(true);
          expect(fits(max + 1)).toBe(false);
        }
      }
    }
  });

  it("takes the fastest eligible machine", () => {
    // Single-sided: M3 (7,200/h, setup 10) → floor((360 − 10) × 7,200 ÷ 60) = 42,000; M4 → 35,500.
    expect(maxCopiesInOneDay(job(1, 1, 50000), makeCtx())).toBe(42000);
    expect(maxCopiesInOneDay(job(1, 1, 50000, "duplex"), makeCtx())).toBe(35500);
  });

  it("is 0 when the setup alone fills the day, or nothing is eligible", () => {
    expect(maxCopiesInOneDay(job(72, 1, 1, "duplex"), makeCtx())).toBe(0);
    expect(maxCopiesInOneDay(job(1, 1, 801, "duplex"), makeCtx({ machines: [M1, M2, M3] }))).toBe(0);
  });

  it("the two halves: Sunday 09:00–14:20, then Monday because M4 has 40 minutes left on Sunday", () => {
    expect(quantities(half)).toEqual({ impressions: 28800, sheets: 14400 });
    const first = placeInHour(half, SUNDAY, 9, makeCtx());
    expect(first).toEqual(placed(4, SUNDAY, "09:00", "14:20"));

    const after = makeCtx({
      busy: [busy(4, SUNDAY, "09:00", "14:20", 42)],
      largeJobsByDate: new Map([[SUNDAY, 1]]),
    });
    expect(placeInHour(half, SUNDAY, 9, after)).toBe("hour_full");
    expect(nearestFreeStart(half, SUNDAY, 9, after)).toEqual(placed(4, MONDAY, "09:00", "14:20"));
    expect(placeInHour(half, MONDAY, 9, after)).toEqual(placed(4, MONDAY, "09:00", "14:20"));
  });
});

describe("latestFreeStart (§3.7, step 2.3)", () => {
  // The contract's delay example: 1 × 2 × 150 single (300 impressions) on M1 11:00–11:20, notice at 09:45.
  const booking = { id: 50, ...job(1, 2, 150), startsAt: t(SUNDAY, "11:00") };
  const own = busy(1, SUNDAY, "11:00", "11:20", 50);

  it("example: latest is 14:50 on M2 and M4; M2 wins the tie (tier group 401 before 801)", () => {
    const ctx = makeCtx({ now: t(SUNDAY, "09:45"), busy: [busy(1, SUNDAY, "14:00", "15:00")], ignoreBookingId: 50 });
    expect(latestFreeStart(booking, ctx)).toEqual(placed(2, SUNDAY, "14:50", "15:00"));
  });

  it("takes a larger machine when only it has the latest start", () => {
    const ctx = makeCtx({
      now: t(SUNDAY, "09:45"),
      busy: [busy(1, SUNDAY, "14:00", "15:00"), busy(2, SUNDAY, "14:00", "15:00"), busy(4, SUNDAY, "14:50", "15:00")],
      ignoreBookingId: 50,
    });
    expect(latestFreeStart(booking, ctx)).toEqual(placed(3, SUNDAY, "14:40", "15:00"));
  });

  it("only starts after the booking's own start count; none → null", () => {
    const afternoon = [1, 2, 3, 4].map((id) => busy(id, SUNDAY, "11:10", "15:00"));
    const ctx = makeCtx({ now: t(SUNDAY, "09:45"), busy: [own, ...afternoon], ignoreBookingId: 50 });
    // 11:00 itself is free once the booking is ignored, but it is not later than its start.
    expect(latestFreeStart(booking, ctx)).toBeNull();
  });

  it("the booking's own interval is not busy for itself; the same date only", () => {
    const allDayButOwn = [2, 3, 4].map((id) => busy(id, SUNDAY, "09:00", "15:00"));
    const ctx = makeCtx({
      now: t(SUNDAY, "09:45"),
      busy: [own, busy(1, SUNDAY, "11:30", "15:00"), ...allDayButOwn],
      ignoreBookingId: 50,
    });
    // M1 is free 11:00–11:30 only (its own slot ignored): 11:10 is the latest start after 11:00. Monday is never tried.
    expect(latestFreeStart(booking, ctx)).toEqual(placed(1, SUNDAY, "11:10", "11:30"));
  });
});
