// Step 2.6b — settings and holidays (contracts §1.12, §4 "Settings", §5): read and patch the settings, list, add and
// remove holidays; a holiday is refused while its date has holding bookings. Skipped when DATABASE_URL is not set.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, bookings, colleges, holidays, machines, settings, users } from "@/db/schema";
import { getAvailability } from "@/lib/actions/bookings";
import { addHoliday, getSettings, listHolidays, removeHoliday, updateSettings } from "@/lib/actions/settings";
import { AuthError, SESSION_COOKIE } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import { atMinutes } from "@/lib/scheduling/time";
import type { BookingStatus } from "@/lib/scheduling/types";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const SUNDAY = "2026-11-29"; // today
const TUE = "2026-12-01";
const WED = "2026-12-02";
const SAT = "2026-12-05";
const PAST = "2026-11-26";
const at = (date: string, hhmm: string) => atMinutes(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const NOW = at(SUNDAY, "09:45");

const DEFAULTS = {
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

const NAMES = ["admin", "operator", "collegeA"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 2.6b: settings and holidays", () => {
  const tokens = {} as Record<Name, string>;
  const ids = {} as Record<Name, number>;
  let collegeId = 0;
  let machineId = 0;
  let seq = 0;

  function actAs(name: Name) {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  }

  async function insertBooking(from: Date, to: Date, status: BookingStatus = "booked"): Promise<number> {
    seq += 1;
    const [row] = await getDb()
      .insert(bookings)
      .values({
        refYear: 2026,
        refSeq: seq,
        reference: `2026-${String(seq).padStart(4, "0")}`,
        collegeId,
        createdBy: ids.collegeA,
        doctorName: "د. أحمد سالم",
        doctorPhone: "218912345678",
        recipientName: "محمد علي حسن الطرابلسي",
        subject: `مادة ${seq}`,
        serviceType: "exam_questions",
        copies: 150,
        models: 1,
        pagesPerModel: 2,
        sides: "single",
        machineId,
        startsAt: from,
        endsAt: to,
        status,
        ...(status === "cancelled" ? { cancelledAt: NOW, cancelledBy: ids.admin } : {}),
        ...(status === "no_show" ? { noShowAt: NOW } : {}),
        ...(status === "in_progress" ? { identityConfirmedAt: NOW } : {}),
      })
      .returning({ id: bookings.id });
    return row.id;
  }

  const job = (date: string) => ({ copies: 150, models: 1, pagesPerModel: 2, sides: "single", date, hour: 10 });
  const settingRow = async (key: string) => (await getDb().select().from(settings).where(eq(settings.key, key)))[0];
  const audits = (action: string) => getDb().select().from(auditLog).where(eq(auditLog.action, action));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    await resetTestDb();
    browser.reset();
    seq = 0;
    const db = getDb();

    const [college] = await db.insert(colleges).values({ name: "كلية أ" }).returning();
    collegeId = college.id;
    const base = { passwordHash: "not-a-real-hash", mustChangePassword: false };
    const userRows = await db
      .insert(users)
      .values([
        { ...base, username: "admin", role: "admin", fullName: "مسؤول" },
        { ...base, username: "operator", role: "operator", fullName: "فني" },
        { ...base, username: "collegeA", role: "college", fullName: "منسق أ", collegeId },
      ])
      .returning({ id: users.id });
    for (const [i, name] of NAMES.entries()) {
      ids[name] = userRows[i].id;
      tokens[name] = (await createSession(db, userRows[i].id, { ip: null, userAgent: null }, new Date())).token;
    }

    await db.insert(settings).values(
      Object.entries({
        work_start: "09:00",
        work_end: "15:00",
        working_weekdays: [0, 1, 2, 3, 4],
        large_job_threshold: 6000,
        large_jobs_per_day: 2,
        edit_deadline_minutes: 60,
        delay_deadline_minutes: 60,
        suggestion_search_days: 14,
        part_warn_percent: 90,
      }).map(([key, value]) => ({ key, value })),
    );
    const [machine] = await db
      .insert(machines)
      .values({
        name: "M1",
        model: "x",
        type: "laser",
        supportsDuplex: true,
        setupMinutesPerModel: 5,
        priority: 1,
        minSheets: 1,
        maxSheets: null,
        speedPerHour: 3000,
      })
      .returning({ id: machines.id });
    machineId = machine.id;
  });

  describe("roles", () => {
    it.each(["operator", "collegeA"] as const)("refuses every action for %s", async (name) => {
      actAs(name);
      await expect(getSettings()).rejects.toBeInstanceOf(AuthError);
      await expect(updateSettings({ largeJobsPerDay: 3 })).rejects.toBeInstanceOf(AuthError);
      await expect(listHolidays()).rejects.toBeInstanceOf(AuthError);
      await expect(addHoliday({ date: TUE, name: "عطلة" })).rejects.toBeInstanceOf(AuthError);
      await expect(removeHoliday({ date: TUE })).rejects.toBeInstanceOf(AuthError);
      expect(await getDb().select().from(holidays)).toHaveLength(0);
    });
  });

  describe("getSettings, updateSettings", () => {
    it("reads every key in camelCase", async () => {
      actAs("admin");
      expect(await getSettings()).toEqual({ ok: true, settings: DEFAULTS });
    });

    it("changes only the keys sent, sorts the weekdays, and audits each change once", async () => {
      actAs("admin");
      const result = await updateSettings({ workEnd: "14:30", workingWeekdays: [4, 0, 6], largeJobsPerDay: 2 });
      expect(result).toEqual({
        ok: true,
        settings: { ...DEFAULTS, workEnd: "14:30", workingWeekdays: [0, 4, 6] },
      });
      expect(await getSettings()).toEqual(result);
      expect(await settingRow("work_end")).toMatchObject({ value: "14:30", updatedBy: ids.admin });
      expect((await settingRow("large_jobs_per_day")).updatedBy).toBeNull(); // sent, but unchanged
      expect((await settingRow("work_start")).updatedBy).toBeNull();

      const rows = await audits("settings.update");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: ids.admin,
        entity: "settings",
        details: {
          changes: {
            work_end: { from: "15:00", to: "14:30" },
            working_weekdays: { from: [0, 1, 2, 3, 4], to: [0, 4, 6] },
          },
        },
      });
    });

    it("writes no audit row when nothing changes", async () => {
      actAs("admin");
      expect(await updateSettings({ workStart: "09:00" })).toEqual({ ok: true, settings: DEFAULTS });
      expect(await audits("settings.update")).toHaveLength(0);
    });

    it("refuses an empty patch", async () => {
      actAs("admin");
      expect(await updateSettings({})).toEqual({ ok: false, error: "validation" });
      expect(await updateSettings(null)).toEqual({ ok: false, error: "validation" });
    });

    // Each bad patch goes with a valid key: all are saved or none.
    it.each([
      ["unknown key", { workStart: "08:00", colour: "red" }],
      ["off the grid", { workStart: "08:05" }],
      ["not HH:MM", { workEnd: "3pm" }],
      ["end before start (merged)", { workEnd: "09:00" }],
      ["start after end (merged)", { workStart: "16:00" }],
      ["no weekdays", { workingWeekdays: [] }],
      ["weekday 7", { workingWeekdays: [0, 7] }],
      ["weekday twice", { workingWeekdays: [1, 1] }],
      ["threshold 0", { largeJobThreshold: 0 }],
      ["negative large jobs", { largeJobsPerDay: -1 }],
      ["fractional deadline", { editDeadlineMinutes: 1.5 }],
      ["search days 61", { suggestionSearchDays: 61 }],
      ["search days 0", { suggestionSearchDays: 0 }],
      ["warn 101", { partWarnPercent: 101 }],
      ["a string number", { delayDeadlineMinutes: "60" }],
    ])("refuses %s and saves nothing", async (_label, patch) => {
      actAs("admin");
      expect(await updateSettings({ largeJobsPerDay: 5, ...patch })).toEqual({ ok: false, error: "validation" });
      expect(await getSettings()).toEqual({ ok: true, settings: DEFAULTS });
      expect(await audits("settings.update")).toHaveLength(0);
    });

    it("accepts start and end changed together", async () => {
      actAs("admin");
      expect(await updateSettings({ workStart: "15:00", workEnd: "18:00" })).toMatchObject({
        ok: true,
        settings: { workStart: "15:00", workEnd: "18:00" },
      });
    });

    it("a new working weekday opens Saturday for every college", async () => {
      actAs("collegeA");
      expect(await getAvailability(job(SAT))).toMatchObject({ availability: { reason: "day_closed" } });
      actAs("admin");
      await updateSettings({ workingWeekdays: [0, 1, 2, 3, 4, 6] });
      actAs("collegeA");
      expect(await getAvailability(job(SAT))).toMatchObject({ availability: { kind: "exact" } });
    });

    it("does not move existing bookings when the hours shrink", async () => {
      const id = await insertBooking(at(TUE, "14:00"), at(TUE, "14:30"));
      actAs("admin");
      await updateSettings({ workEnd: "12:00" });
      const [row] = await getDb().select().from(bookings).where(eq(bookings.id, id));
      expect(row).toMatchObject({ startsAt: at(TUE, "14:00"), needsReschedule: false, status: "booked" });
    });
  });

  describe("addHoliday", () => {
    it("adds a holiday, audits it, and closes the date for everyone", async () => {
      actAs("admin");
      expect(await addHoliday({ date: TUE, name: "  عيد الاستقلال  " })).toEqual({
        ok: true,
        holiday: { date: TUE, name: "عيد الاستقلال" },
      });
      const [row] = await getDb().select().from(holidays);
      expect(row).toMatchObject({ date: TUE, name: "عيد الاستقلال", createdBy: ids.admin });
      expect(await audits("holiday.add")).toMatchObject([
        { userId: ids.admin, entity: "holidays", entityId: TUE, details: { name: "عيد الاستقلال" } },
      ]);
      actAs("collegeA");
      expect(await getAvailability(job(TUE))).toMatchObject({
        availability: { kind: "suggestion", reason: "day_closed", placement: { startsAt: at(WED, "10:00") } },
      });
    });

    it("takes today, refuses a past date, a blank name and a bad date", async () => {
      actAs("admin");
      expect(await addHoliday({ date: SUNDAY, name: "عطلة" })).toMatchObject({ ok: true });
      for (const input of [
        { date: PAST, name: "عطلة" },
        { date: TUE, name: "   " },
        { date: "2026-02-30", name: "عطلة" },
        { date: TUE },
        { date: TUE, name: "عطلة", extra: 1 },
      ]) {
        expect(await addHoliday(input)).toEqual({ ok: false, error: "validation" });
      }
      expect(await getDb().select().from(holidays)).toHaveLength(1);
    });

    it("answers duplicate for a date that is already a holiday", async () => {
      actAs("admin");
      await addHoliday({ date: TUE, name: "عطلة" });
      expect(await addHoliday({ date: TUE, name: "أخرى" })).toEqual({ ok: false, error: "duplicate" });
      expect(await audits("holiday.add")).toHaveLength(1);
    });

    it("is refused while the date has holding bookings, listed by start; cancelled and no-show do not count", async () => {
      const late = await insertBooking(at(TUE, "13:00"), at(TUE, "13:30"));
      const early = await insertBooking(at(TUE, "09:00"), at(TUE, "09:30"));
      await insertBooking(at(TUE, "10:00"), at(TUE, "10:30"), "cancelled");
      await insertBooking(at(TUE, "11:00"), at(TUE, "11:30"), "no_show");
      await insertBooking(at(WED, "09:00"), at(WED, "09:30")); // another day

      actAs("admin");
      expect(await addHoliday({ date: TUE, name: "عطلة" })).toEqual({
        ok: false,
        error: "has_bookings",
        bookings: [
          { id: early, reference: "2026-0002", startsAt: at(TUE, "09:00") },
          { id: late, reference: "2026-0001", startsAt: at(TUE, "13:00") },
        ],
      });
      expect(await getDb().select().from(holidays)).toHaveLength(0);
      expect(await audits("holiday.add")).toHaveLength(0);

      await getDb().update(bookings).set({ status: "cancelled", cancelledAt: NOW, cancelledBy: ids.admin });
      expect(await addHoliday({ date: TUE, name: "عطلة" })).toMatchObject({ ok: true });
    });

    it("counts a job running today", async () => {
      const id = await insertBooking(at(SUNDAY, "09:30"), at(SUNDAY, "10:00"), "in_progress");
      actAs("admin");
      expect(await addHoliday({ date: SUNDAY, name: "عطلة" })).toMatchObject({
        ok: false,
        error: "has_bookings",
        bookings: [{ id }],
      });
    });
  });

  describe("listHolidays, removeHoliday", () => {
    it("lists every holiday, past ones too, newest date first, with the creator's name", async () => {
      await getDb().insert(holidays).values({ date: PAST, name: "قديمة", createdBy: ids.admin });
      actAs("admin");
      await addHoliday({ date: TUE, name: "عطلة ١" });
      await addHoliday({ date: SAT, name: "عطلة ٢" });
      const result = await listHolidays();
      expect(result.ok).toBe(true);
      expect(result.items.map((h) => [h.date, h.name, h.createdByName])).toEqual([
        [SAT, "عطلة ٢", "مسؤول"],
        [TUE, "عطلة ١", "مسؤول"],
        [PAST, "قديمة", "مسؤول"],
      ]);
    });

    it("removes a holiday dated today or later, audits it, and the date opens again", async () => {
      actAs("admin");
      await addHoliday({ date: TUE, name: "عطلة" });
      await addHoliday({ date: SUNDAY, name: "اليوم" });
      expect(await removeHoliday({ date: TUE })).toEqual({ ok: true });
      expect(await removeHoliday({ date: SUNDAY })).toEqual({ ok: true });
      expect(await getDb().select().from(holidays)).toHaveLength(0);
      expect(await audits("holiday.remove")).toMatchObject([
        { entityId: TUE, details: { name: "عطلة" } },
        { entityId: SUNDAY, details: { name: "اليوم" } },
      ]);
      actAs("collegeA");
      expect(await getAvailability(job(TUE))).toMatchObject({ availability: { kind: "exact" } });
    });

    it("refuses a past holiday, answers not_found for a date that is none, validation for a bad date", async () => {
      await getDb().insert(holidays).values({ date: PAST, name: "قديمة", createdBy: ids.admin });
      actAs("admin");
      expect(await removeHoliday({ date: PAST })).toEqual({ ok: false, error: "refused" });
      expect(await removeHoliday({ date: TUE })).toEqual({ ok: false, error: "not_found" });
      expect(await removeHoliday({ date: "tomorrow" })).toEqual({ ok: false, error: "validation" });
      expect(await getDb().select().from(holidays)).toHaveLength(1);
      expect(await audits("holiday.remove")).toHaveLength(0);
    });
  });
});
