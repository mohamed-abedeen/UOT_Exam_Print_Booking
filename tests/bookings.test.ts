// Step 1.4 — booking transaction: createBooking and getAvailability against the test database.
// Machines are the contract's example machines (§3); the clock is frozen on Sunday 2026-11-29, 08:00 Tripoli time.
// Skipped when DATABASE_URL is not set.
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, bookings, colleges, holidays, machineMaintenance, machines, notifications, settings, users } from "@/db/schema";
import { createBooking, getAvailability } from "@/lib/actions/bookings";
import { AuthError, SESSION_COOKIE, type Actor } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import { createBookingFor, getAvailabilityFor, isPlacementConflict, MAX_RETRIES } from "@/lib/bookings/create";
import { examDateWarning, formatReference, isFourPartName, normalizePhone } from "@/lib/scheduling/helpers";
import { atMinutes } from "@/lib/scheduling/time";
import type { Placement } from "@/lib/scheduling/types";
import { browser, Redirected } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

describe("step 1.4: helpers (contracts §3.10)", () => {
  it("normalizePhone", () => {
    expect(normalizePhone("091-2345678")).toBe("218912345678");
    expect(normalizePhone("+218 92 123 4567")).toBe("218921234567");
    expect(normalizePhone("00218912345678")).toBe("218912345678");
    expect(normalizePhone("912345678")).toBe("218912345678");
    expect(normalizePhone("(091) 234 5678")).toBe("218912345678");
    expect(normalizePhone("218912345678")).toBe("218912345678");
    expect(normalizePhone("0213601234")).toBeNull();
    expect(normalizePhone("09123456789")).toBeNull();
    expect(normalizePhone("091234567")).toBeNull();
    expect(normalizePhone("09a2345678")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("isFourPartName", () => {
    expect(isFourPartName("محمد علي حسن الطرابلسي")).toBe(true);
    expect(isFourPartName("  محمد  علي حسن سالم الطرابلسي ")).toBe(true);
    expect(isFourPartName("محمد علي حسن")).toBe(false);
    expect(isFourPartName("محمد علي حسن م")).toBe(false);
    expect(isFourPartName("")).toBe(false);
  });

  it("examDateWarning", () => {
    expect(examDateWarning("2026-11-29", null)).toBe(false);
    expect(examDateWarning("2026-11-29", "2026-11-30")).toBe(false);
    expect(examDateWarning("2026-11-29", "2026-11-29")).toBe(true);
    expect(examDateWarning("2026-11-30", "2026-11-29")).toBe(true);
  });

  it("formatReference", () => {
    expect(formatReference(2026, 42)).toBe("2026-0042");
    expect(formatReference(2026, 9999)).toBe("2026-9999");
    expect(formatReference(2026, 10000)).toBe("2026-10000");
  });

  it("isPlacementConflict: exclusion violation and deadlock only, also when wrapped", () => {
    expect(isPlacementConflict({ code: "23P01" })).toBe(true);
    expect(isPlacementConflict({ code: "40P01" })).toBe(true);
    expect(isPlacementConflict(new Error("query failed", { cause: { code: "23P01" } }))).toBe(true);
    expect(isPlacementConflict({ code: "23505" })).toBe(false);
    expect(isPlacementConflict(new Error("boom"))).toBe(false);
    expect(isPlacementConflict(null)).toBe(false);
  });
});

const SUNDAY = "2026-11-29";
const MONDAY = "2026-11-30";
const FRIDAY = "2026-12-04";
const at = (date: string, hhmm: string) => atMinutes(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const NOW = at(SUNDAY, "08:00");

const NAMES = ["admin", "operator", "collegeA", "collegeB"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 1.4: booking transaction", () => {
  const ids = {} as Record<Name, number>;
  const collegeIds = {} as { A: number; B: number; inactive: number };
  const tokens = {} as Record<Name, string>;
  const m = {} as { M1: number; M2: number; M3: number; M4: number };
  let rivalSeq = 0;

  function actAs(name: Name) {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  }
  /** An actor for the calls that skip the cookie (parallel requests from different users, the test hook). */
  function actor(name: Name): Actor {
    return {
      sessionId: "test",
      userId: ids[name],
      role: name === "admin" ? "admin" : name === "operator" ? "operator" : "college",
      collegeId: name === "collegeA" ? collegeIds.A : name === "collegeB" ? collegeIds.B : null,
      username: name,
      fullName: name,
      mustChangePassword: false,
      ip: null,
    };
  }

  // 1 model × 2 pages × 150 copies, single = 300 impressions: 20 min on M1 and M3, 10 min on M2 and M4.
  const form = (over: Record<string, unknown> = {}) => ({
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
    ...over,
  });
  const job = (over: Record<string, unknown> = {}) => ({
    copies: 150,
    models: 1,
    pagesPerModel: 2,
    sides: "single",
    date: SUNDAY,
    hour: 10,
    ...over,
  });

  const allBookings = () => getDb().select().from(bookings).orderBy(bookings.id);
  const bookingById = async (id: number) => (await getDb().select().from(bookings).where(eq(bookings.id, id)))[0];
  async function overlappingPairs(): Promise<number> {
    const rows = await getDb().execute(sql`
      SELECT count(*)::int AS n FROM bookings a JOIN bookings b
        ON a.id < b.id AND a.machine_id = b.machine_id AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at
      WHERE a.status NOT IN ('cancelled', 'no_show') AND b.status NOT IN ('cancelled', 'no_show')`);
    return Number((rows[0] as { n: number }).n);
  }

  /** A row written straight into the table, without the lock: an existing booking, or a rival that slipped in. */
  async function insertBooking(
    machineId: number,
    startsAt: Date,
    endsAt: Date,
    over: Partial<typeof bookings.$inferInsert> = {},
  ) {
    rivalSeq += 1;
    await getDb()
      .insert(bookings)
      .values({
        refYear: 1999,
        refSeq: rivalSeq,
        reference: `1999-${String(rivalSeq).padStart(4, "0")}`,
        collegeId: collegeIds.B,
        createdBy: ids.collegeB,
        doctorName: "د. منافس",
        doctorPhone: "218921234567",
        recipientName: "سالم عمر خالد الزاوي",
        subject: "فيزياء",
        serviceType: "exam_questions",
        copies: 10,
        models: 1,
        pagesPerModel: 1,
        sides: "single",
        machineId,
        startsAt,
        endsAt,
        ...over,
      });
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    await resetTestDb();
    browser.reset();
    rivalSeq = 0;
    const db = getDb();

    const [a, b, c] = await db
      .insert(colleges)
      .values([{ name: "كلية أ" }, { name: "كلية ب" }, { name: "كلية موقوفة", isActive: false }])
      .returning();
    Object.assign(collegeIds, { A: a.id, B: b.id, inactive: c.id });

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

    const laser = { model: "x", type: "laser" as const, supportsDuplex: true, setupMinutesPerModel: 5, priority: 1 };
    const machineRows = await db
      .insert(machines)
      .values([
        { ...laser, name: "M1", minSheets: 1, maxSheets: 400, speedPerHour: 3000 },
        { ...laser, name: "M2", minSheets: 401, maxSheets: 800, speedPerHour: 4200 },
        { name: "M3", model: "x", type: "duplicator", minSheets: 801, maxSheets: null, supportsDuplex: false, speedPerHour: 7200, setupMinutesPerModel: 10, priority: 1 },
        { ...laser, name: "M4", minSheets: 801, maxSheets: null, speedPerHour: 6000, priority: 2 },
      ])
      .returning({ id: machines.id });
    Object.assign(m, { M1: machineRows[0].id, M2: machineRows[1].id, M3: machineRows[2].id, M4: machineRows[3].id });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- the "Done when" of step 1.4

  describe("parallel requests at the same hour never overlap on one machine", () => {
    it("24 requests through the action: the hour's 18 places are filled once each, the rest get a suggestion", async () => {
      actAs("collegeA");
      // Hour 10 holds 3 jobs on M1, 6 on M2, 3 on M3 and 6 on M4.
      const results = await Promise.all(Array.from({ length: 24 }, () => createBooking(form())));

      const booked = results.filter((r) => r.ok);
      const refused = results.filter((r) => !r.ok);
      expect(booked).toHaveLength(18);
      expect(refused).toHaveLength(6);
      for (const r of refused) {
        expect(r).toMatchObject({ error: "needs_confirmation", availability: { kind: "suggestion", reason: "hour_full" } });
      }

      // The counts and the references carry the proof: without the lock, tries run out or a reference repeats.
      // The constraint alone already keeps overlappingPairs() at 0.
      const rows = await allBookings();
      expect(rows).toHaveLength(18);
      expect(await overlappingPairs()).toBe(0);
      for (const row of rows) {
        expect(row.startsAt.getTime()).toBeGreaterThanOrEqual(at(SUNDAY, "10:00").getTime());
        expect(row.startsAt.getTime()).toBeLessThanOrEqual(at(SUNDAY, "10:50").getTime());
      }
      const perMachine = (id: number) => rows.filter((r) => r.machineId === id).length;
      expect([perMachine(m.M1), perMachine(m.M2), perMachine(m.M3), perMachine(m.M4)]).toEqual([3, 6, 3, 6]);
      // One reference each, no gap and no repeat.
      expect(rows.map((r) => r.reference).sort()).toEqual(
        Array.from({ length: 18 }, (_, i) => formatReference(2026, i + 1)),
      );
    });

    it("three users with different jobs at once: every placement is free of the others", async () => {
      const inputs = Array.from({ length: 30 }, (_, i) => {
        const who = (["collegeA", "collegeB", "admin"] as const)[i % 3];
        const size = [{ copies: 150 }, { copies: 300 }, { copies: 900, pagesPerModel: 4 }][i % 3 === 0 ? i % 2 : (i + 1) % 3];
        return { who, input: form({ ...size, ...(who === "admin" ? { collegeId: collegeIds.A } : {}) }) };
      });
      const results = await Promise.all(inputs.map(({ who, input }) => createBookingFor(actor(who), input)));

      const booked = results.filter((r) => r.ok).length;
      expect(booked).toBeGreaterThan(0);
      for (const r of results) if (!r.ok) expect(r.error).toBe("needs_confirmation");
      const rows = await allBookings();
      expect(rows).toHaveLength(booked);
      expect(await overlappingPairs()).toBe(0);
      expect(new Set(rows.map((r) => r.refSeq)).size).toBe(booked);
      expect(Math.max(...rows.map((r) => r.refSeq))).toBe(booked);
    });
  });

  it("the clock is read after the wait for the lock, never before", async () => {
    const waitingForLock = async () => {
      const rows = await getDb().execute(
        sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
      );
      return Number((rows[0] as { n: number }).n) > 0;
    };
    let second: ReturnType<typeof createBookingFor> | undefined;
    const first = await createBookingFor(actor("collegeA"), form(), {
      // Runs while the first request holds the lock.
      async beforeInsert() {
        second = createBookingFor(actor("collegeB"), form());
        for (let i = 0; i < 200 && !(await waitingForLock()); i++) await new Promise((r) => setTimeout(r, 10));
        expect(await waitingForLock()).toBe(true);
        vi.setSystemTime(at(SUNDAY, "10:35"));
      },
    });
    expect(first.ok).toBe(true);
    const result = await second!;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // At 08:00 the second request would take M1 at 10:20; it got the lock at 10:35, so that start is past.
    expect(await bookingById(result.booking.id)).toMatchObject({ machineId: m.M1, startsAt: at(SUNDAY, "10:40") });
  });

  describe("retry on conflict: the constraint is the final authority", () => {
    it("a conflict on an accepted placement: the retry finds it taken and answers slot_taken", async () => {
      let tries = 0;
      const result = await createBookingFor(
        actor("collegeA"),
        form({ accept: { machineId: m.M1, startsAt: at(SUNDAY, "10:00") } }),
        {
          async beforeInsert(placement) {
            tries += 1;
            await insertBooking(placement.machineId, placement.startsAt, placement.endsAt);
          },
        },
      );
      expect(tries).toBe(1);
      expect(result).toMatchObject({
        ok: false,
        error: "slot_taken",
        availability: { kind: "exact", placement: { machineId: m.M1, startsAt: at(SUNDAY, "10:20") } },
      });
      expect(await allBookings()).toHaveLength(1);
    });

    it("a rival row that slipped past the lock: the try is rolled back and the next one books another start", async () => {
      const seen: { placement: Placement; attempt: number }[] = [];
      const result = await createBookingFor(actor("collegeA"), form(), {
        async beforeInsert(placement, attempt) {
          seen.push({ placement, attempt });
          if (attempt === 0) await insertBooking(placement.machineId, placement.startsAt, placement.endsAt);
        },
      });

      expect(seen.map((s) => s.attempt)).toEqual([0, 1]);
      expect(seen[0].placement).toMatchObject({ machineId: m.M1, startsAt: at(SUNDAY, "10:00") });
      expect(result).toMatchObject({ ok: true, booking: { reference: "2026-0001" } });
      if (!result.ok) return;
      expect(await bookingById(result.booking.id)).toMatchObject({
        machineId: m.M1,
        startsAt: at(SUNDAY, "10:20"),
        endsAt: at(SUNDAY, "10:40"),
        refSeq: 1, // the rolled-back try used no number
      });
      expect(await allBookings()).toHaveLength(2);
      expect(await overlappingPairs()).toBe(0);
    });

    it("a conflict on every try: 1 try + 3 retries, then slot_taken with fresh availability and nothing written", async () => {
      let tries = 0;
      const result = await createBookingFor(actor("collegeA"), form(), {
        async beforeInsert(placement) {
          tries += 1;
          await insertBooking(placement.machineId, placement.startsAt, placement.endsAt);
        },
      });

      expect(MAX_RETRIES).toBe(3);
      expect(tries).toBe(1 + MAX_RETRIES);
      expect(result).toMatchObject({ ok: false, error: "slot_taken" });
      // M1 lost 10:00, 10:20 and 10:40; M2 lost 10:00. Fresh answer: M2 at 10:10.
      expect(result).toMatchObject({
        availability: { kind: "exact", placement: { machineId: m.M2, startsAt: at(SUNDAY, "10:10") } },
      });
      const rows = await allBookings();
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.refYear === 1999)).toBe(true);
    });

    it("any other error is not retried", async () => {
      let tries = 0;
      await expect(
        createBookingFor(actor("collegeA"), form(), {
          async beforeInsert() {
            tries += 1;
            throw new Error("boom");
          },
        }),
      ).rejects.toThrow("boom");
      expect(tries).toBe(1);
      expect(await allBookings()).toHaveLength(0);
    });
  });

  // ---- T1

  describe("createBooking writes the row", () => {
    it("a college books an exact hour", async () => {
      actAs("collegeA");
      const result = await createBooking(form());
      expect(result).toMatchObject({ ok: true, booking: { reference: "2026-0001" }, examDateWarning: false });
      if (!result.ok) return;
      expect(await bookingById(result.booking.id)).toMatchObject({
        refYear: 2026,
        refSeq: 1,
        collegeId: collegeIds.A,
        createdBy: ids.collegeA,
        onBehalf: false,
        doctorName: "د. أحمد سالم",
        doctorPhone: "218912345678",
        recipientName: "محمد علي حسن الطرابلسي",
        subject: "رياضيات 1",
        serviceType: "exam_questions",
        copies: 150,
        models: 1,
        pagesPerModel: 2,
        sides: "single",
        examDate: null,
        impressions: 300,
        sheets: 300,
        machineId: m.M1,
        startsAt: at(SUNDAY, "10:00"),
        endsAt: at(SUNDAY, "10:20"),
        workDate: SUNDAY,
        status: "booked",
        needsReschedule: false,
      });
      expect(await getDb().select().from(auditLog)).toHaveLength(0);
    });

    it("references count up, and text fields are trimmed", async () => {
      actAs("collegeA");
      await createBooking(form());
      const second = await createBooking(form({ subject: "  كيمياء  " }));
      expect(second).toMatchObject({ ok: true, booking: { reference: "2026-0002" } });
      if (!second.ok) return;
      expect(await bookingById(second.booking.id)).toMatchObject({ subject: "كيمياء", startsAt: at(SUNDAY, "10:20") });
    });

    it("the exam date only warns", async () => {
      actAs("collegeA");
      expect(await createBooking(form({ examDate: SUNDAY }))).toMatchObject({ ok: true, examDateWarning: true });
      expect(await createBooking(form({ examDate: MONDAY }))).toMatchObject({ ok: true, examDateWarning: false });
      expect(await allBookings()).toHaveLength(2);
    });

    it("a larger machine takes a smaller job only when the smaller one has no start in the hour", async () => {
      await insertBooking(m.M1, at(SUNDAY, "09:50"), at(SUNDAY, "11:00"));
      actAs("collegeA");
      const result = await createBooking(form());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(await bookingById(result.booking.id)).toMatchObject({
        machineId: m.M2,
        startsAt: at(SUNDAY, "10:00"),
        endsAt: at(SUNDAY, "10:10"),
      });
    });
  });

  describe("what occupies an interval", () => {
    it("every status except cancelled and no_show holds its interval", async () => {
      const slot = [m.M1, at(SUNDAY, "10:00"), at(SUNDAY, "10:20")] as const;
      const confirmed = { identityConfirmedAt: NOW, identityConfirmedBy: ids.operator };
      const ready = { ...confirmed, readyAt: NOW, readyBy: ids.operator, wastedSheets: 0, wasteDestroyed: true };
      actAs("collegeA");

      await insertBooking(...slot, { status: "cancelled", cancelledAt: NOW });
      await insertBooking(...slot, { status: "no_show", noShowAt: NOW });
      expect(await getAvailability(job())).toMatchObject({
        availability: { kind: "exact", placement: { machineId: m.M1, startsAt: at(SUNDAY, "10:00") } },
      });

      for (const over of [
        { status: "in_progress", ...confirmed },
        { status: "ready", ...ready },
        { status: "delivered", ...ready, deliveredAt: NOW },
      ] as const) {
        await getDb().delete(bookings);
        await insertBooking(...slot, over);
        expect(await getAvailability(job())).toMatchObject({
          availability: { kind: "exact", placement: { machineId: m.M1, startsAt: at(SUNDAY, "10:20") } },
        });
      }
    });

    it("a machine in maintenance is skipped; a cancelled planned window blocks nothing", async () => {
      const row = { machineId: m.M1, reason: "صيانة", createdBy: ids.admin };
      const [cancelled] = await getDb()
        .insert(machineMaintenance)
        .values({ ...row, startsAt: at(SUNDAY, "10:10"), endsAt: at(SUNDAY, "10:10") })
        .returning({ id: machineMaintenance.id });
      actAs("collegeA");
      expect(await getAvailability(job())).toMatchObject({
        availability: { kind: "exact", placement: { machineId: m.M1, startsAt: at(SUNDAY, "10:00") } },
      });

      await getDb().delete(machineMaintenance).where(eq(machineMaintenance.id, cancelled.id));
      await getDb().insert(machineMaintenance).values({ ...row, startsAt: at(SUNDAY, "09:00"), endsAt: null });
      const result = await createBooking(form());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(await bookingById(result.booking.id)).toMatchObject({ machineId: m.M2, startsAt: at(SUNDAY, "10:00") });
    });

    it("a holiday closes the day: the suggestion is the same hour on the next open day", async () => {
      await getDb().insert(holidays).values({ date: SUNDAY, name: "عطلة", createdBy: ids.admin });
      actAs("collegeA");
      expect(await createBooking(form())).toMatchObject({
        ok: false,
        error: "needs_confirmation",
        availability: {
          kind: "suggestion",
          reason: "day_closed",
          placement: { machineId: m.M1, startsAt: at(MONDAY, "10:00"), endsAt: at(MONDAY, "10:20") },
        },
      });
      expect(await allBookings()).toHaveLength(0);
    });

    it("a non-working weekday is closed for everyone (Saturday approvals arrive in step 2.6)", async () => {
      actAs("collegeA");
      expect(await getAvailability(job({ date: FRIDAY }))).toMatchObject({
        availability: { kind: "suggestion", reason: "day_closed", placement: { startsAt: at("2026-12-06", "10:00") } },
      });
    });

    it("the large-job limit counts the day's holding rows, not cancelled ones", async () => {
      const large = { copies: 7000 }; // 7,000 impressions > 6,000
      await insertBooking(m.M3, at(SUNDAY, "09:00"), at(SUNDAY, "10:10"), large);
      await insertBooking(m.M4, at(SUNDAY, "09:00"), at(SUNDAY, "10:20"), {
        ...large,
        status: "cancelled",
        cancelledAt: NOW,
      });
      actAs("collegeA");
      // One holding large job: a second one is allowed (M4 is free at 11:00; 7,000 impressions = 80 minutes there).
      const second = await createBooking(form({ copies: 7000, pagesPerModel: 1, hour: 11 }));
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(await bookingById(second.booking.id)).toMatchObject({ machineId: m.M3, startsAt: at(SUNDAY, "11:00") });

      // Two holding large jobs: the third goes to the next open day.
      expect(await createBooking(form({ copies: 6001, pagesPerModel: 1, hour: 13 }))).toMatchObject({
        ok: false,
        error: "needs_confirmation",
        availability: { kind: "suggestion", reason: "large_job_limit", placement: { startsAt: at(MONDAY, "13:00") } },
      });
      // 6,000 is not large.
      expect(await createBooking(form({ copies: 6000, pagesPerModel: 1, hour: 13 }))).toMatchObject({ ok: true });
    });
  });

  describe("no exact placement: nothing is written", () => {
    it("a suggestion needs confirmation; accepting it books it, with the end computed on the server", async () => {
      actAs("collegeA");
      // Hour 8 is before opening: the nearest start is 09:00.
      const first = await createBooking(form({ hour: 8 }));
      expect(first).toMatchObject({
        ok: false,
        error: "needs_confirmation",
        availability: {
          kind: "suggestion",
          reason: "day_closed",
          placement: { machineId: m.M1, startsAt: at(SUNDAY, "09:00"), endsAt: at(SUNDAY, "09:20") },
        },
      });
      expect(await allBookings()).toHaveLength(0);
      if (first.ok || first.availability?.kind !== "suggestion") throw new Error("expected a suggestion");

      const accept = { ...first.availability.placement, endsAt: at(SUNDAY, "14:00") }; // a wrong end is ignored
      const second = await createBooking(form({ hour: 8, accept }));
      expect(second).toMatchObject({ ok: true, booking: { reference: "2026-0001" } });
      if (!second.ok) return;
      expect(await bookingById(second.booking.id)).toMatchObject({
        machineId: m.M1,
        startsAt: at(SUNDAY, "09:00"),
        endsAt: at(SUNDAY, "09:20"),
      });
    });

    it("an accepted placement that is no longer bookable: slot_taken with fresh availability", async () => {
      await insertBooking(m.M2, at(SUNDAY, "11:00"), at(SUNDAY, "11:30"));
      await getDb().insert(holidays).values({ date: MONDAY, name: "عطلة", createdBy: ids.admin });
      await getDb().update(machines).set({ archivedAt: NOW }).where(eq(machines.id, m.M4));
      await getDb().insert(machineMaintenance).values({
        machineId: m.M1,
        reason: "صيانة",
        createdBy: ids.admin,
        startsAt: at(SUNDAY, "12:00"),
        endsAt: at(SUNDAY, "13:00"),
      });
      actAs("collegeA");
      const bad: [string, { machineId: number; startsAt: Date }, Record<string, unknown>?][] = [
        ["taken meanwhile", { machineId: m.M2, startsAt: at(SUNDAY, "11:20") }],
        ["inside maintenance", { machineId: m.M1, startsAt: at(SUNDAY, "12:10") }],
        ["runs into maintenance", { machineId: m.M1, startsAt: at(SUNDAY, "11:50") }],
        ["ends inside a booking", { machineId: m.M2, startsAt: at(SUNDAY, "10:50") }, { copies: 300 }],
        ["before now", { machineId: m.M1, startsAt: at(SUNDAY, "07:50") }],
        ["yesterday", { machineId: m.M1, startsAt: at("2026-11-26", "10:00") }],
        ["off the grid", { machineId: m.M1, startsAt: at(SUNDAY, "10:05") }],
        ["before opening", { machineId: m.M1, startsAt: at(SUNDAY, "08:50") }],
        ["runs past closing", { machineId: m.M1, startsAt: at(SUNDAY, "14:50") }],
        ["closed weekday", { machineId: m.M1, startsAt: at(FRIDAY, "10:00") }],
        ["holiday", { machineId: m.M1, startsAt: at(MONDAY, "10:00") }],
        ["unknown machine", { machineId: 9999, startsAt: at(SUNDAY, "10:00") }],
        ["archived machine", { machineId: m.M4, startsAt: at(SUNDAY, "10:00") }],
        ["machine too small", { machineId: m.M1, startsAt: at(SUNDAY, "10:00") }, { copies: 300 }],
        ["no duplex", { machineId: m.M3, startsAt: at(SUNDAY, "10:00") }, { sides: "duplex" }],
      ];
      for (const [name, accept, over] of bad) {
        const result = await createBooking(form({ ...over, accept }));
        expect(result, name).toMatchObject({ ok: false, error: "slot_taken", availability: { kind: "exact" } });
      }
      expect(await allBookings()).toHaveLength(1);

      // The same request with a good start is booked.
      expect(await createBooking(form({ accept: { machineId: m.M2, startsAt: at(SUNDAY, "11:30") } }))).toMatchObject({
        ok: true,
      });
    });

    it("a job longer than the day is refused with the most copies that fit", async () => {
      actAs("collegeA");
      // contracts §3.6: 6 × 8 × 1,200 duplex, only M4 is eligible, 687 copies fit in 360 minutes.
      const long = { models: 6, pagesPerModel: 8, copies: 1200, sides: "duplex", hour: 9 };
      const refusal = { kind: "none", reason: "too_long", maxCopies: 687 };
      expect(await createBooking(form(long))).toMatchObject({ ok: false, error: "refused", availability: refusal });
      // Also with an accepted placement: it cannot end before the close.
      expect(
        await createBooking(form({ ...long, accept: { machineId: m.M4, startsAt: at(SUNDAY, "09:00") } })),
      ).toMatchObject({ ok: false, error: "slot_taken", availability: refusal });
      expect(await allBookings()).toHaveLength(0);
    });

    it("no eligible machine: refused", async () => {
      await getDb().update(machines).set({ archivedAt: NOW }).where(eq(machines.id, m.M4));
      actAs("collegeA");
      expect(await createBooking(form({ sides: "duplex", copies: 1000 }))).toMatchObject({
        ok: false,
        error: "refused",
        availability: { kind: "none", reason: "no_machine" },
      });
      expect(await allBookings()).toHaveLength(0);
    });

    it("an hour that has passed: the suggestion is the nearest start still ahead", async () => {
      vi.setSystemTime(at(SUNDAY, "11:05"));
      actAs("collegeA");
      expect(await createBooking(form({ hour: 10 }))).toMatchObject({
        ok: false,
        error: "needs_confirmation",
        availability: { kind: "suggestion", reason: "past", placement: { startsAt: at(SUNDAY, "11:10") } },
      });
    });

    it("invalid input is refused before anything is read", async () => {
      actAs("collegeA");
      const bad: Record<string, unknown>[] = [
        { doctorPhone: "0213601234" },
        { doctorPhone: 912345678 },
        { recipientName: "محمد علي حسن" },
        { doctorName: "   " },
        { doctorName: "د. أحمد\u0000" },
        { accept: { machineId: m.M1, startsAt: new Date(8.64e15) } },
        { subject: "" },
        { subject: "س".repeat(201) },
        { serviceType: "posters" },
        { copies: 0 },
        { copies: 20001 },
        { copies: 1.5 },
        { copies: "150" },
        { models: 0 },
        { models: 51 },
        { pagesPerModel: 0 },
        { pagesPerModel: 501 },
        { sides: "both" },
        { examDate: "soon" },
        { examDate: undefined },
        { date: "2026-02-30" },
        { date: "29-11-2026" },
        { hour: 24 },
        { hour: -1 },
        { hour: 10.5 },
        { accept: { machineId: m.M1, startsAt: "2026-11-29T08:00:00Z" } },
        { accept: { machineId: m.M1, startsAt: new Date(NaN) } },
        { accept: { machineId: 0, startsAt: at(SUNDAY, "10:00") } },
      ];
      for (const over of bad) {
        expect(await createBooking(form(over)), JSON.stringify(over)).toEqual({ ok: false, error: "validation" });
      }
      expect(await createBooking(null)).toEqual({ ok: false, error: "validation" });
      expect(await createBooking("x")).toEqual({ ok: false, error: "validation" });
      expect(await allBookings()).toHaveLength(0);
    });
  });

  // ---- permissions (contracts §4 rules 1–3)

  describe("who may book, and for which college", () => {
    it("no session → login; operator → refused", async () => {
      browser.reset();
      await expect(createBooking(form())).rejects.toMatchObject({ to: "/login" });
      await expect(getAvailability(job())).rejects.toBeInstanceOf(Redirected);
      actAs("operator");
      await expect(createBooking(form())).rejects.toBeInstanceOf(AuthError);
      await expect(getAvailability(job())).rejects.toBeInstanceOf(AuthError);
      await expect(createBookingFor(actor("operator"), form())).rejects.toBeInstanceOf(AuthError);
      await expect(getAvailabilityFor(actor("operator"), job())).rejects.toBeInstanceOf(AuthError);
      expect(await allBookings()).toHaveLength(0);
    });

    it("a college's booking is its own; a collegeId in its request is refused, even its own or an invalid one", async () => {
      actAs("collegeA");
      for (const collegeId of [collegeIds.B, collegeIds.A, "2", null]) {
        await expect(createBooking(form({ collegeId }))).rejects.toBeInstanceOf(AuthError);
        await expect(getAvailability(job({ collegeId }))).rejects.toBeInstanceOf(AuthError);
      }
      // Also when the rest of the form is invalid.
      await expect(createBooking(form({ collegeId: collegeIds.B, copies: 0 }))).rejects.toBeInstanceOf(AuthError);
      expect(await allBookings()).toHaveLength(0);

      actAs("collegeB");
      const result = await createBooking(form());
      expect(result.ok).toBe(true);
      expect((await allBookings()).map((r) => [r.collegeId, r.createdBy, r.onBehalf])).toEqual([
        [collegeIds.B, ids.collegeB, false],
      ]);
    });

    it("an admin books on behalf of a college: flagged and audited", async () => {
      actAs("admin");
      expect(await createBooking(form())).toEqual({ ok: false, error: "validation" });
      expect(await getAvailability(job())).toEqual({ ok: false, error: "validation" });
      expect(await createBooking(form({ collegeId: String(collegeIds.B) }))).toEqual({ ok: false, error: "validation" });

      const result = await createBooking(form({ collegeId: collegeIds.B }));
      expect(result).toMatchObject({ ok: true, booking: { reference: "2026-0001" } });
      if (!result.ok) return;
      expect(await bookingById(result.booking.id)).toMatchObject({
        collegeId: collegeIds.B,
        createdBy: ids.admin,
        onBehalf: true,
      });
      const audits = await getDb().select().from(auditLog);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        userId: ids.admin,
        role: "admin",
        action: "booking.create_on_behalf",
        entity: "bookings",
        entityId: String(result.booking.id),
        collegeId: collegeIds.B,
      });
      expect(audits[0].details).toMatchObject({ reference: "2026-0001", machineId: m.M1 });
      // Step 2.1: `booking_on_behalf` to each active user of that college, nobody else.
      const rows = await getDb().select().from(notifications);
      expect(rows.map((n) => [n.userId, n.type, n.bookingId])).toEqual([
        [ids.collegeB, "booking_on_behalf", result.booking.id],
      ]);
      expect(rows[0].data).toMatchObject({ reference: "2026-0001" });
    });

    it("an inactive or unknown college cannot be booked for", async () => {
      actAs("admin");
      for (const collegeId of [collegeIds.inactive, 9999]) {
        expect(await createBooking(form({ collegeId }))).toEqual({ ok: false, error: "validation" });
        expect(await getAvailability(job({ collegeId }))).toEqual({ ok: false, error: "validation" });
      }
      await getDb().update(colleges).set({ isActive: false }).where(eq(colleges.id, collegeIds.A));
      expect(await createBookingFor(actor("collegeA"), form())).toEqual({ ok: false, error: "validation" });
      expect(await allBookings()).toHaveLength(0);
      expect(await getDb().select().from(auditLog)).toHaveLength(0);
    });
  });

  // ---- getAvailability

  describe("getAvailability", () => {
    it("answers exact, suggestion or none, and writes nothing", async () => {
      actAs("collegeA");
      expect(await getAvailability(job())).toEqual({
        ok: true,
        availability: {
          kind: "exact",
          placement: { machineId: m.M1, startsAt: at(SUNDAY, "10:00"), endsAt: at(SUNDAY, "10:20") },
        },
      });
      expect(await getAvailability(job({ hour: 8 }))).toMatchObject({
        ok: true,
        availability: { kind: "suggestion", reason: "day_closed", placement: { startsAt: at(SUNDAY, "09:00") } },
      });
      expect(
        await getAvailability(job({ models: 6, pagesPerModel: 8, copies: 1200, sides: "duplex" })),
      ).toEqual({ ok: true, availability: { kind: "none", reason: "too_long", maxCopies: 687 } });

      actAs("admin");
      expect(await getAvailability(job({ collegeId: collegeIds.B }))).toMatchObject({
        ok: true,
        availability: { kind: "exact" },
      });
      expect(await allBookings()).toHaveLength(0);
      expect(await getDb().select().from(auditLog)).toHaveLength(0);
    });

    it("sees what was booked a moment ago", async () => {
      actAs("collegeA");
      await createBooking(form());
      expect(await getAvailability(job())).toMatchObject({
        availability: { kind: "exact", placement: { machineId: m.M1, startsAt: at(SUNDAY, "10:20") } },
      });
    });

    it("invalid input and keys it does not know (bookingId: step 2.3) are refused", async () => {
      actAs("collegeA");
      for (const over of [{ copies: 0 }, { sides: "both" }, { date: "2026-13-01" }, { hour: 24 }, { bookingId: 1 }]) {
        expect(await getAvailability(job(over)), JSON.stringify(over)).toEqual({ ok: false, error: "validation" });
      }
      expect(await getAvailability(undefined)).toEqual({ ok: false, error: "validation" });
    });
  });
});
