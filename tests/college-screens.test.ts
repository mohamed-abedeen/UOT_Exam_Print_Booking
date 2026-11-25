// Step 1.6 — college screens: the reads behind them (listBookings, getBookingFormConfig) and the pure display
// helpers. The clock is frozen on Sunday 2026-11-29, 08:00 Tripoli time. DB tests skip without DATABASE_URL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { bookings, colleges, machines, settings, users } from "@/db/schema";
import { createBooking, getBookingFormConfig, listBookings } from "@/lib/actions/bookings";
import { AuthError, SESSION_COOKIE } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import {
  dayOf,
  digits,
  formatDay,
  hourLabel,
  REFUSAL_LABEL,
  SERVICE_LABEL,
  SIDES_LABEL,
  startHours,
  STATUS_LABEL,
  timeOf,
} from "@/lib/bookings/format";
import { normalizePhone } from "@/lib/scheduling/helpers";
import { atMinutes } from "@/lib/scheduling/time";
import { browser, Redirected } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const SUNDAY = "2026-11-29";
const MONDAY = "2026-11-30";
const at = (date: string, hhmm: string) => atMinutes(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const NOW = at(SUNDAY, "08:00");

describe("step 1.6: display helpers", () => {
  it("startHours: every hour with at least one working minute", () => {
    expect(startHours("09:00", "15:00")).toEqual([9, 10, 11, 12, 13, 14]);
    expect(startHours("09:30", "14:30")).toEqual([9, 10, 11, 12, 13, 14]);
    expect(startHours("08:00", "08:30")).toEqual([8]);
    expect(hourLabel(9)).toBe("09:00");
    expect(hourLabel(14)).toBe("14:00");
  });

  it("digits: Arabic-Indic and Persian digits become 0-9, so a phone typed on an Arabic keyboard is read", () => {
    expect(digits("٠٩١٢٣٤٥٦٧٨")).toBe("0912345678");
    expect(digits("۰۹۱۲۳۴۵۶۷۸")).toBe("0912345678");
    expect(digits("٠٩١-٢٣٤٥٦٧٨ abc")).toBe("091-2345678 abc");
    expect(normalizePhone(digits("٠٩١٢٣٤٥٦٧٨"))).toBe("218912345678");
    expect(normalizePhone(digits("+٢١٨ ٩١ ٢٣٤ ٥٦٧٨"))).toBe("218912345678");
  });

  it("dayOf and timeOf use the +02:00 business clock", () => {
    expect(timeOf(at(SUNDAY, "09:30"))).toBe("09:30");
    expect(dayOf(at(SUNDAY, "09:30"))).toBe(SUNDAY);
    // 00:30 local on Monday is 22:30 UTC on Sunday: the business day is Monday.
    expect(dayOf(at(MONDAY, "00:30"))).toBe(MONDAY);
    expect(timeOf(at(MONDAY, "00:30"))).toBe("00:30");
    expect(dayOf(at(SUNDAY, "23:50"))).toBe(SUNDAY);
  });

  it("formatDay names the weekday", () => {
    expect(formatDay(SUNDAY)).toBe("الأحد 2026-11-29");
    expect(formatDay("2026-12-04")).toBe("الجمعة 2026-12-04");
  });

  it("every refusal, state, service and side has an Arabic label", () => {
    for (const label of [
      ...Object.values(REFUSAL_LABEL),
      ...Object.values(STATUS_LABEL),
      ...Object.values(SERVICE_LABEL),
      ...Object.values(SIDES_LABEL),
    ]) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
    expect(Object.keys(REFUSAL_LABEL).sort()).toEqual(
      ["day_closed", "hour_full", "large_job_limit", "no_free_slot", "no_machine", "past", "saturday_quota", "too_long"],
    );
    expect(Object.keys(STATUS_LABEL)).toHaveLength(6);
  });
});

const NAMES = ["admin", "operator", "collegeA", "collegeB"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 1.6: listBookings and getBookingFormConfig", () => {
  const ids = {} as Record<Name, number>;
  const collegeIds = {} as { A: number; B: number };
  const tokens = {} as Record<Name, string>;
  let machineId = 0;
  let seq = 0;

  function actAs(name: Name) {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  }

  /** A row written straight into the table, for one of the two colleges. */
  async function insertBooking(
    college: "A" | "B",
    startsAt: Date,
    over: Partial<typeof bookings.$inferInsert> = {},
  ) {
    seq += 1;
    const [row] = await getDb()
      .insert(bookings)
      .values({
        refYear: 2026,
        refSeq: seq,
        reference: `2026-${String(seq).padStart(4, "0")}`,
        collegeId: collegeIds[college],
        createdBy: college === "A" ? ids.collegeA : ids.collegeB,
        doctorName: "د. سري",
        doctorPhone: "218921234567",
        recipientName: "سالم عمر خالد الزاوي",
        subject: `مادة ${college}${seq}`,
        serviceType: "exam_questions",
        copies: 10,
        models: 1,
        pagesPerModel: 1,
        sides: "single",
        machineId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 10 * 60_000),
        ...over,
      })
      .returning({ id: bookings.id });
    return row.id;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    await resetTestDb();
    browser.reset();
    seq = 0;
    const db = getDb();

    const [a, b] = await db.insert(colleges).values([{ name: "كلية أ" }, { name: "كلية ب" }]).returning();
    Object.assign(collegeIds, { A: a.id, B: b.id });

    const base = { passwordHash: "not-a-real-hash", mustChangePassword: false };
    const userRows = await db
      .insert(users)
      .values([
        { ...base, username: "admin", role: "admin", fullName: "مسؤول" },
        { ...base, username: "operator", role: "operator", fullName: "فني" },
        { ...base, username: "collegeA", role: "college", fullName: "منسق أ", collegeId: a.id },
        { ...base, username: "collegeB", role: "college", fullName: "منسق ب", collegeId: b.id },
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
        minSheets: 1,
        maxSheets: 400,
        supportsDuplex: true,
        speedPerHour: 3000,
        setupMinutesPerModel: 5,
        priority: 1,
      })
      .returning({ id: machines.id });
    machineId = machine.id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("listBookings", () => {
    it("a college gets its own rows only, newest start first, with every status", async () => {
      const early = await insertBooking("A", at(SUNDAY, "10:00"));
      const late = await insertBooking("A", at(MONDAY, "10:00"));
      const cancelled = await insertBooking("A", at(SUNDAY, "11:00"), {
        status: "cancelled",
        cancelledAt: NOW,
        cancelledBy: ids.collegeA,
      });
      await insertBooking("B", at(SUNDAY, "12:00"));
      await insertBooking("B", at(MONDAY, "12:00"));

      actAs("collegeA");
      const result = await listBookings({});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.bookings.map((b) => b.id)).toEqual([late, cancelled, early]);
      expect(result.bookings.every((b) => b.collegeId === collegeIds.A)).toBe(true);
      expect(result.bookings.map((b) => b.status)).toEqual(["booked", "cancelled", "booked"]);

      actAs("collegeB");
      const other = await listBookings();
      expect(other.ok && other.bookings.every((b) => b.collegeId === collegeIds.B)).toBe(true);
      expect(other.ok && other.bookings).toHaveLength(2);
    });

    it("a row carries the list's fields and no machine, phone or name of a person", async () => {
      await insertBooking("A", at(SUNDAY, "10:00"));
      actAs("collegeA");
      const result = await listBookings({});
      if (!result.ok) throw new Error("expected ok");
      expect(Object.keys(result.bookings[0]).sort()).toEqual(
        [
          "canDelay",
          "canEdit",
          "collegeId",
          "copies",
          "delayedFrom",
          "endsAt",
          "id",
          "models",
          "needsReschedule",
          "pagesPerModel",
          "reference",
          "serviceType",
          "sides",
          "startsAt",
          "status",
          "subject",
        ].sort(),
      );
    });

    it("canEdit and canDelay follow the two deadlines (60 min), the status, the flag and the one notice (step 2.5)", async () => {
      const tooLate = await insertBooking("A", at(SUNDAY, "08:50")); // 50 min away: inside both deadlines
      const onEdge = await insertBooking("A", at(SUNDAY, "09:00")); // exactly 60 min: still allowed
      const delayed = await insertBooking("A", at(SUNDAY, "10:00"), { delayNoticeAt: NOW, delayedFrom: at(SUNDAY, "09:30") });
      const flagged = await insertBooking("A", at(SUNDAY, "11:00"), { needsReschedule: true, rescheduleReason: "maintenance" });
      const started = await insertBooking("A", at(SUNDAY, "12:00"), {
        status: "cancelled",
        cancelledAt: NOW,
        cancelledBy: ids.collegeA,
      });

      actAs("collegeA");
      const result = await listBookings({});
      if (!result.ok) throw new Error("expected ok");
      const by = new Map(result.bookings.map((b) => [b.id, b]));
      const flags = (id: number) => [by.get(id)!.canEdit, by.get(id)!.canDelay];
      expect(flags(tooLate)).toEqual([false, false]);
      expect(flags(onEdge)).toEqual([true, true]);
      expect(flags(delayed)).toEqual([true, false]); // one notice only
      expect(flags(flagged)).toEqual([true, false]); // waiting for the admin: no notice, edit is allowed
      expect(flags(started)).toEqual([false, false]);
      expect(by.get(delayed)!.delayedFrom).toEqual(at(SUNDAY, "09:30"));
      expect(by.get(flagged)!.needsReschedule).toBe(true);

      // An admin edits any booked row at any time, and never sends a delay notice.
      actAs("admin");
      const asAdmin = await listBookings({});
      if (!asAdmin.ok) throw new Error("expected ok");
      const adminBy = new Map(asAdmin.bookings.map((b) => [b.id, b]));
      expect([adminBy.get(tooLate)!.canEdit, adminBy.get(tooLate)!.canDelay]).toEqual([true, false]);
      expect([adminBy.get(onEdge)!.canEdit, adminBy.get(onEdge)!.canDelay]).toEqual([true, false]);
      expect([adminBy.get(started)!.canEdit, adminBy.get(started)!.canDelay]).toEqual([false, false]);
    });

    it("a college that names a college is refused, its own or another, valid or not", async () => {
      await insertBooking("B", at(SUNDAY, "12:00"));
      actAs("collegeA");
      await expect(listBookings({ collegeId: collegeIds.B })).rejects.toBeInstanceOf(AuthError);
      await expect(listBookings({ collegeId: collegeIds.A })).rejects.toBeInstanceOf(AuthError);
      await expect(listBookings({ collegeId: "x" })).rejects.toBeInstanceOf(AuthError);
      await expect(listBookings({ collegeId: -1 })).rejects.toBeInstanceOf(AuthError);
    });

    it("an unknown key is a validation error, not ignored", async () => {
      actAs("collegeA");
      expect(await listBookings({ status: "booked" })).toEqual({ ok: false, error: "validation" });
      actAs("admin");
      expect(await listBookings({ collegeId: "x" })).toEqual({ ok: false, error: "validation" });
      expect(await listBookings({ collegeId: 0 })).toEqual({ ok: false, error: "validation" });
    });

    it("an admin gets all rows, or one college's", async () => {
      await insertBooking("A", at(SUNDAY, "10:00"));
      await insertBooking("B", at(SUNDAY, "11:00"));
      await insertBooking("B", at(SUNDAY, "12:00"));

      actAs("admin");
      const all = await listBookings({});
      expect(all.ok && all.bookings).toHaveLength(3);
      const onlyB = await listBookings({ collegeId: collegeIds.B });
      expect(onlyB.ok && onlyB.bookings).toHaveLength(2);
      expect(onlyB.ok && onlyB.bookings.every((b) => b.collegeId === collegeIds.B)).toBe(true);
    });

    it("an operator is refused; no session goes to the login page", async () => {
      await insertBooking("A", at(SUNDAY, "10:00"));
      actAs("operator");
      await expect(listBookings({})).rejects.toBeInstanceOf(AuthError);
      browser.reset();
      await expect(listBookings({})).rejects.toMatchObject({ to: "/login" });
      await expect(listBookings({})).rejects.toBeInstanceOf(Redirected);
    });

    it("book, then follow: a booking made through createBooking appears in the list at once", async () => {
      actAs("collegeA");
      const made = await createBooking({
        doctorName: "د. أحمد سالم",
        doctorPhone: "091-2345678",
        recipientName: "محمد علي حسن الطرابلسي",
        subject: "رياضيات 1",
        serviceType: "exam_questions",
        copies: 150,
        models: 1,
        pagesPerModel: 2,
        sides: "single",
        examDate: null,
        date: SUNDAY,
        hour: 10,
      });
      expect(made.ok).toBe(true);
      if (!made.ok) return;

      const result = await listBookings({});
      if (!result.ok) throw new Error("expected ok");
      expect(result.bookings).toHaveLength(1);
      expect(result.bookings[0]).toMatchObject({
        id: made.booking.id,
        reference: made.booking.reference,
        subject: "رياضيات 1",
        copies: 150,
        status: "booked",
      });
      expect(dayOf(result.bookings[0].startsAt)).toBe(SUNDAY);
      expect(timeOf(result.bookings[0].startsAt)).toBe("10:00");

      actAs("collegeB");
      const theirs = await listBookings({});
      expect(theirs.ok && theirs.bookings).toHaveLength(0);
    });
  });

  describe("getBookingFormConfig", () => {
    it("returns the working hours, the working weekdays and today, and nothing else", async () => {
      for (const name of ["collegeA", "admin"] as const) {
        actAs(name);
        expect(await getBookingFormConfig()).toEqual({
          workStart: "09:00",
          workEnd: "15:00",
          workingWeekdays: [0, 1, 2, 3, 4],
          today: SUNDAY,
        });
      }
    });

    it("today is the business date: 23:30 Sunday UTC is already Monday in Tripoli", async () => {
      vi.setSystemTime(new Date("2026-11-29T23:30:00Z"));
      // The 8-hour idle limit has passed since the session of beforeEach: sign in again at the new time.
      const { token } = await createSession(getDb(), ids.collegeA, { ip: null, userAgent: null }, new Date());
      browser.reset();
      browser.cookies.set(SESSION_COOKIE, token);
      expect((await getBookingFormConfig()).today).toBe(MONDAY);
    });

    it("an operator is refused; no session goes to the login page", async () => {
      actAs("operator");
      await expect(getBookingFormConfig()).rejects.toBeInstanceOf(AuthError);
      browser.reset();
      await expect(getBookingFormConfig()).rejects.toMatchObject({ to: "/login" });
    });
  });
});
