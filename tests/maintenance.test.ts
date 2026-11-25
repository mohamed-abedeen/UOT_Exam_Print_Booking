// Step 2.4 — maintenance (contracts §1.5, §3.7 moveBooking, §3.8, §4): stop now or a planned window, the automatic
// move to another machine at the same start, `needs_reschedule`, reactivation, the log, the admin's manual move, and
// archive / edit of a machine. Skipped when DATABASE_URL is not set.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, bookings, colleges, machineMaintenance, machines, notifications, settings, users } from "@/db/schema";
import { getAvailability, listNeedsReschedule, moveBooking } from "@/lib/actions/bookings";
import { archiveMachine, unarchiveMachine, updateMachine } from "@/lib/actions/machines";
import { endMaintenance, listMaintenance, startMaintenance } from "@/lib/actions/maintenance";
import { AuthError, SESSION_COOKIE, type Actor } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import { moveBookingFor } from "@/lib/bookings/change";
import { atMinutes } from "@/lib/scheduling/time";
import type { BookingStatus, Placement } from "@/lib/scheduling/types";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const SATURDAY = "2026-11-28";
const SUNDAY = "2026-11-29";
const MONDAY = "2026-11-30";
const at = (date: string, hhmm: string) => atMinutes(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const NOW = at(SATURDAY, "12:00"); // the day before: a stop recorded now for Sunday is a planned window

const NAMES = ["admin", "operator", "collegeA", "collegeB"] as const;
type Name = (typeof NAMES)[number];

// Jobs (contracts §3 example machines; durations in the comments).
const JOB_500 = { models: 2, pagesPerModel: 5, copies: 50, sides: "single" } as const; // M2 20, M3 30, M4 20
const JOB_600_DUPLEX = { models: 1, pagesPerModel: 6, copies: 100, sides: "duplex" } as const; // M2 20, M4 20
const JOB_900_DUPLEX = { models: 1, pagesPerModel: 9, copies: 100, sides: "duplex" } as const; // M4 only, 20
const JOB_300_DUPLEX = { models: 1, pagesPerModel: 2, copies: 150, sides: "duplex" } as const; // M1 20, M4 10
const JOB_LARGE = { models: 1, pagesPerModel: 1, copies: 7000, sides: "single" } as const; // 7,000: M3 70, M4 80

describe.skipIf(!process.env.DATABASE_URL)("step 2.4: maintenance", () => {
  const tokens = {} as Record<Name, string>;
  const ids = {} as Record<Name, number>;
  const collegeIds = {} as { A: number; B: number };
  const m = {} as { M1: number; M2: number; M3: number; M4: number };
  let seq = 0;

  /** Moves the clock; the sessions are made again, so a jump of a day does not end them. */
  async function setNow(t: Date) {
    vi.setSystemTime(t);
    for (const name of NAMES) {
      tokens[name] = (await createSession(getDb(), ids[name], { ip: null, userAgent: null }, t)).token;
    }
  }
  function actAs(name: Name) {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  }
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
    } as Actor;
  }

  /** The columns a status needs to pass the §1.7 CHECKs. */
  function statusColumns(status: BookingStatus): Partial<typeof bookings.$inferInsert> {
    const t = new Date(NOW.getTime() - 60_000);
    const by = ids.operator;
    const confirmed = { identityConfirmedAt: t, identityConfirmedBy: by };
    const ready = { ...confirmed, readyAt: t, readyBy: by, wastedSheets: 0, wasteDestroyed: true };
    switch (status) {
      case "booked":
        return {};
      case "in_progress":
        return confirmed;
      case "ready":
        return ready;
      case "delivered":
        return { ...ready, deliveredAt: t, deliveredBy: by };
      case "cancelled":
        return { cancelledAt: t, cancelledBy: by };
      case "no_show":
        return { noShowAt: t, noShowBy: by };
    }
  }

  /** A row written straight into the table. Default: college A, 1 × 2 × 150 single (300 impressions). */
  async function insert(
    machineId: number,
    from: Date,
    to: Date,
    over: Partial<typeof bookings.$inferInsert> = {},
    status: BookingStatus = "booked",
  ): Promise<number> {
    seq += 1;
    const [row] = await getDb()
      .insert(bookings)
      .values({
        refYear: 2026,
        refSeq: seq,
        reference: `2026-${String(seq).padStart(4, "0")}`,
        collegeId: collegeIds.A,
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
        ...statusColumns(status),
        ...over,
      })
      .returning({ id: bookings.id });
    return row.id;
  }
  const on = (date: string, machineId: number, from: string, to: string, over = {}, status: BookingStatus = "booked") =>
    insert(machineId, at(date, from), at(date, to), over, status);
  /** College B's rows stand for "the machine is busy". */
  const busyFor = (date: string, machineId: number, from: string, to: string, over = {}) =>
    on(date, machineId, from, to, { collegeId: collegeIds.B, createdBy: ids.collegeB, ...over });

  const row = async (id: number) => (await getDb().select().from(bookings).where(eq(bookings.id, id)))[0];
  const ref = (n: number) => `2026-${String(n).padStart(4, "0")}`;
  const touched = async (id: number) => ({ id, reference: (await row(id)).reference });
  const placementOf = (r: { machineId: number; startsAt: Date; endsAt: Date }) => ({
    machineId: r.machineId,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
  });
  const placed = (date: string, machineId: number, from: string, to: string): Placement => ({
    machineId,
    startsAt: at(date, from),
    endsAt: at(date, to),
  });
  const flagOf = async (id: number) => {
    const r = await row(id);
    return { needsReschedule: r.needsReschedule, rescheduleReason: r.rescheduleReason };
  };
  const allNotifications = () => getDb().select().from(notifications).orderBy(notifications.id);
  const allAudits = () => getDb().select().from(auditLog).orderBy(auditLog.id);
  const stop = (machineId: number, over: Record<string, unknown> = {}) => ({
    machineId,
    startsAt: at(SUNDAY, "10:00"),
    endsAt: at(SUNDAY, "12:00"),
    reason: "صيانة دورية",
    ...over,
  });

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

    // The contract's example machines M1–M4 (§3).
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

  /** The contract's §3.8 example: B1 and B2 on M2, M4 busy 10:30–11:30, B3 later that day. */
  async function contractExample() {
    const b1 = await on(SUNDAY, m.M2, "10:10", "10:30", JOB_500);
    const b2 = await on(SUNDAY, m.M2, "11:00", "11:20", JOB_600_DUPLEX);
    const b3 = await on(SUNDAY, m.M2, "13:00", "13:20", JOB_500);
    await busyFor(SUNDAY, m.M4, "10:30", "11:30");
    return { b1, b2, b3 };
  }

  // ---- startMaintenance

  describe("startMaintenance", () => {
    it("contract example, planned the day before: B1 moved to M3 at the same start, B2 flagged, B3 untouched", async () => {
      const { b1, b2, b3 } = await contractExample();
      actAs("admin");

      const result = await startMaintenance(stop(m.M2));
      expect(result).toEqual({
        ok: true,
        maintenance: { id: expect.any(Number) },
        moved: [{ id: b1, reference: ref(1) }],
        flagged: [{ id: b2, reference: ref(2) }],
      });

      // Alternative exists: same start, the end from M3's speed; no flag, nobody told (the time did not change).
      expect(placementOf(await row(b1))).toEqual(placed(SUNDAY, m.M3, "10:10", "10:40"));
      expect(await flagOf(b1)).toEqual({ needsReschedule: false, rescheduleReason: null });
      // No alternative: it keeps its machine and interval, flagged; the college and the admins are told.
      expect(placementOf(await row(b2))).toEqual(placed(SUNDAY, m.M2, "11:00", "11:20"));
      expect(await flagOf(b2)).toEqual({ needsReschedule: true, rescheduleReason: "maintenance" });
      expect(placementOf(await row(b3))).toEqual(placed(SUNDAY, m.M2, "13:00", "13:20"));
      expect((await allNotifications()).map((n) => [n.userId, n.type, n.bookingId])).toEqual([
        [ids.collegeA, "booking_needs_reschedule", b2],
        [ids.admin, "booking_needs_reschedule", b2],
      ]);
      expect((await allAudits()).map((a) => [a.action, a.entityId])).toEqual([
        ["maintenance.start", String(result.ok && result.maintenance.id)],
        ["booking.auto_move", String(b1)],
        ["booking.flag_reschedule", String(b2)],
      ]);

      const [stored] = await getDb().select().from(machineMaintenance);
      expect(stored).toMatchObject({
        machineId: m.M2,
        startsAt: at(SUNDAY, "10:00"),
        endsAt: at(SUNDAY, "12:00"),
        reason: "صيانة دورية",
        createdBy: ids.admin,
        endedBy: null,
      });
      expect(await listNeedsReschedule()).toMatchObject({ ok: true, bookings: [{ id: b2, rescheduleReason: "maintenance" }] });

      // From now on the window is busy time: a new 500-impression job at 10:00 does not land on M2.
      actAs("collegeA");
      expect(await getAvailability({ ...JOB_500, date: SUNDAY, hour: 10 })).toEqual({
        ok: true,
        availability: { kind: "exact", placement: placed(SUNDAY, m.M4, "10:00", "10:20") },
      });
    });

    it("stop now, no end: every later booking on the machine, an in_progress one too; the rest untouched", async () => {
      await setNow(at(SUNDAY, "10:15"));
      const ended = await on(SUNDAY, m.M4, "10:00", "10:10"); // ended before now
      const running = await on(SUNDAY, m.M4, "10:10", "10:30", {}, "in_progress");
      const onlyM4 = await on(MONDAY, m.M4, "09:00", "09:20", JOB_900_DUPLEX);
      const movable = await on(MONDAY, m.M4, "10:00", "10:10");
      const delayed = await on(MONDAY, m.M4, "11:00", "11:20", {
        ...JOB_900_DUPLEX,
        needsReschedule: true,
        rescheduleReason: "delay_no_slot",
        delayNoticeAt: at(SUNDAY, "09:00"),
        delayedFrom: at(MONDAY, "10:30"),
      });
      const cancelled = await on(MONDAY, m.M4, "12:00", "12:20", {}, "cancelled");
      const elsewhere = await on(MONDAY, m.M1, "13:00", "13:20");
      actAs("admin");

      const result = await startMaintenance({ machineId: m.M4, endsAt: null, reason: "عطل في الدرج" });
      expect(result).toMatchObject({
        ok: true,
        moved: [await touched(running), await touched(movable)],
        flagged: [await touched(onlyM4), await touched(delayed)],
      });
      const [stored] = await getDb().select().from(machineMaintenance);
      expect(stored).toMatchObject({ startsAt: at(SUNDAY, "10:15"), endsAt: null });

      expect(placementOf(await row(running))).toEqual(placed(SUNDAY, m.M1, "10:10", "10:30")); // same start, M1's end
      expect((await row(running)).status).toBe("in_progress");
      expect(placementOf(await row(movable))).toEqual(placed(MONDAY, m.M1, "10:00", "10:20"));
      expect(await flagOf(onlyM4)).toEqual({ needsReschedule: true, rescheduleReason: "maintenance" });
      // Already flagged: keeps its reason, audit only, nobody told again.
      expect(await flagOf(delayed)).toEqual({ needsReschedule: true, rescheduleReason: "delay_no_slot" });
      for (const id of [ended, cancelled]) expect((await row(id)).machineId).toBe(m.M4);
      expect(placementOf(await row(elsewhere))).toEqual(placed(MONDAY, m.M1, "13:00", "13:20"));

      expect((await allNotifications()).map((n) => n.bookingId)).toEqual([onlyM4, onlyM4]);
      const flags = (await allAudits()).filter((a) => a.action === "booking.flag_reschedule");
      expect(flags.map((a) => [a.entityId, a.details])).toEqual([
        [String(onlyM4), { reference: ref(3), cause: "maintenance" }],
        [String(delayed), { reference: ref(5), cause: "maintenance", kept: "delay_no_slot" }],
      ]);
    });

    it("refuses an overlap, a past or empty window, an archived or unknown machine, bad input and other roles", async () => {
      actAs("admin");
      expect(await startMaintenance(stop(m.M2))).toMatchObject({ ok: true });
      expect(await startMaintenance(stop(m.M2, { startsAt: at(SUNDAY, "11:50"), endsAt: at(SUNDAY, "13:00") }))).toEqual({
        ok: false,
        error: "overlaps",
      });
      // Touching end to start is not an overlap ('[)').
      expect(await startMaintenance(stop(m.M2, { startsAt: at(SUNDAY, "12:00"), endsAt: at(SUNDAY, "13:00") }))).toMatchObject({
        ok: true,
      });

      expect(await startMaintenance(stop(m.M1, { startsAt: at(SATURDAY, "11:59") }))).toEqual({ ok: false, error: "validation" });
      expect(await startMaintenance(stop(m.M1, { endsAt: at(SUNDAY, "10:00") }))).toEqual({ ok: false, error: "validation" });
      // Stop now with an end that is not after now.
      expect(await startMaintenance({ machineId: m.M1, endsAt: at(SATURDAY, "12:00"), reason: "x" })).toEqual({
        ok: false,
        error: "validation",
      });
      expect(await startMaintenance(stop(m.M1, { reason: "   " }))).toEqual({ ok: false, error: "validation" });
      expect(await startMaintenance(stop(m.M1, { collegeId: 1 }))).toEqual({ ok: false, error: "validation" });
      expect(await startMaintenance(stop(9999))).toEqual({ ok: false, error: "not_found" });
      await getDb().update(machines).set({ archivedAt: NOW }).where(eq(machines.id, m.M3));
      expect(await startMaintenance(stop(m.M3))).toEqual({ ok: false, error: "not_found" });

      for (const name of ["operator", "collegeA"] as const) {
        actAs(name);
        await expect(startMaintenance(stop(m.M1))).rejects.toBeInstanceOf(AuthError);
        await expect(endMaintenance({ maintenanceId: 1 })).rejects.toBeInstanceOf(AuthError);
        await expect(listMaintenance()).rejects.toBeInstanceOf(AuthError);
      }
    });
  });

  // ---- endMaintenance and the log

  describe("endMaintenance", () => {
    it("reactivated early (contract example, 10:40): B2 restored and its college told; B1 stays on M3", async () => {
      const { b1, b2 } = await contractExample();
      actAs("admin");
      const started = await startMaintenance(stop(m.M2));
      if (!started.ok) throw new Error("not started");

      await setNow(at(SUNDAY, "10:40"));
      actAs("admin");
      expect(await endMaintenance({ maintenanceId: started.maintenance.id })).toEqual({
        ok: true,
        restored: [{ id: b2, reference: ref(2) }],
      });
      expect(await flagOf(b2)).toEqual({ needsReschedule: false, rescheduleReason: null });
      expect(placementOf(await row(b2))).toEqual(placed(SUNDAY, m.M2, "11:00", "11:20"));
      expect(placementOf(await row(b1))).toEqual(placed(SUNDAY, m.M3, "10:10", "10:40"));
      const restoredNotes = (await allNotifications()).filter((n) => n.type === "booking_restored");
      expect(restoredNotes.map((n) => [n.userId, n.bookingId])).toEqual([[ids.collegeA, b2]]);

      expect(await listMaintenance()).toEqual({
        ok: true,
        items: [
          {
            id: started.maintenance.id,
            machineId: m.M2,
            machineName: "M2",
            startsAt: at(SUNDAY, "10:00"),
            endsAt: at(SUNDAY, "10:40"),
            reason: "صيانة دورية",
            createdByName: "مسؤول",
            endedByName: "مسؤول",
            endedAt: at(SUNDAY, "10:40"),
            minutes: 40,
          },
        ],
      });
      // Ended once: a second press is refused.
      expect(await endMaintenance({ maintenanceId: started.maintenance.id })).toEqual({ ok: false, error: "refused" });
      expect(await endMaintenance({ maintenanceId: 9999 })).toEqual({ ok: false, error: "not_found" });
      expect(await endMaintenance({ maintenanceId: "1" })).toEqual({ ok: false, error: "validation" });
    });

    it("a planned window cancelled before it starts: ends_at = starts_at, stays in the log, blocks nothing", async () => {
      const b2 = await on(SUNDAY, m.M2, "11:00", "11:20", JOB_600_DUPLEX);
      await busyFor(SUNDAY, m.M4, "10:30", "11:30");
      actAs("admin");
      const started = await startMaintenance(stop(m.M2));
      if (!started.ok) throw new Error("not started");
      expect(started.flagged).toEqual([{ id: b2, reference: ref(1) }]);

      expect(await endMaintenance({ maintenanceId: started.maintenance.id })).toEqual({
        ok: true,
        restored: [{ id: b2, reference: ref(1) }],
      });
      const [stored] = await getDb().select().from(machineMaintenance);
      expect(stored).toMatchObject({ startsAt: at(SUNDAY, "10:00"), endsAt: at(SUNDAY, "10:00"), endedBy: ids.admin, endedAt: NOW });
      expect(await listMaintenance({ machineId: m.M2 })).toMatchObject({ ok: true, items: [{ minutes: 0 }] });
      expect(await listMaintenance({ machineId: m.M1 })).toEqual({ ok: true, items: [] });
      expect(await listMaintenance({ machineId: "x" })).toEqual({ ok: false, error: "validation" });
      // A cancelled window blocks nothing: the same window can be recorded again.
      expect(await startMaintenance(stop(m.M2))).toMatchObject({ ok: true });
    });

    it("restores only a booking with no stop left over it, still on the machine and still eligible", async () => {
      const early = await on(SUNDAY, m.M2, "10:00", "10:20", JOB_600_DUPLEX);
      const late = await on(SUNDAY, m.M2, "13:00", "13:20", JOB_600_DUPLEX);
      await busyFor(SUNDAY, m.M4, "09:00", "15:00");
      actAs("admin");
      const first = await startMaintenance(stop(m.M2, { startsAt: at(SUNDAY, "09:00"), endsAt: at(SUNDAY, "11:00") }));
      const second = await startMaintenance(stop(m.M2, { startsAt: at(SUNDAY, "12:00"), endsAt: at(SUNDAY, "14:00") }));
      if (!first.ok || !second.ok) throw new Error("not started");

      // The first window ends; the late booking still lies in the second one.
      expect(await endMaintenance({ maintenanceId: first.maintenance.id })).toEqual({
        ok: true,
        restored: [{ id: early, reference: ref(1) }],
      });
      expect(await flagOf(late)).toEqual({ needsReschedule: true, rescheduleReason: "maintenance" });
    });
  });

  // ---- moveBooking

  describe("moveBooking", () => {
    it("places a flagged booking on the admin's target: end from that machine, flag cleared, audited, college told", async () => {
      const { b2 } = await contractExample();
      actAs("admin");
      await startMaintenance(stop(m.M2));
      const before = (await allNotifications()).length;

      expect(await moveBooking({ bookingId: b2, machineId: m.M4, startsAt: at(SUNDAY, "14:00") })).toEqual({
        ok: true,
        booking: { id: b2, reference: ref(2), ...placed(SUNDAY, m.M4, "14:00", "14:20") },
      });
      expect(await flagOf(b2)).toEqual({ needsReschedule: false, rescheduleReason: null });
      expect(await listNeedsReschedule()).toEqual({ ok: true, bookings: [] });
      const notes = (await allNotifications()).slice(before);
      expect(notes.map((n) => [n.userId, n.type, n.bookingId])).toEqual([[ids.collegeA, "booking_rescheduled", b2]]);
      const [audit] = (await allAudits()).filter((a) => a.action === "booking.move");
      expect(audit).toMatchObject({ entityId: String(b2), userId: ids.admin, collegeId: collegeIds.A });
      expect(audit.details).toMatchObject({ reference: ref(2), flagCleared: true });
    });

    it("refuses a target that fails a rule, with the reason; nothing changes", async () => {
      await setNow(at(SUNDAY, "10:45"));
      const b = await on(SUNDAY, m.M2, "11:00", "11:20", JOB_600_DUPLEX);
      await busyFor(SUNDAY, m.M4, "10:30", "11:30");
      actAs("admin");
      const move = (machineId: number, date: string, hhmm: string) =>
        moveBooking({ bookingId: b, machineId, startsAt: at(date, hhmm) });
      const refused = (reason: string) => ({ ok: false, error: "slot_taken", reason });

      expect(await move(m.M1, SUNDAY, "13:00")).toEqual(refused("not_eligible")); // max 400 < 600
      expect(await move(m.M3, SUNDAY, "13:00")).toEqual(refused("not_eligible")); // no duplex
      expect(await move(9999, SUNDAY, "13:00")).toEqual(refused("not_eligible"));
      expect(await move(m.M4, SUNDAY, "10:30")).toEqual(refused("past")); // booked: not before now
      expect(await move(m.M4, SUNDAY, "11:20")).toEqual(refused("busy"));
      expect(await move(m.M4, SUNDAY, "14:50")).toEqual(refused("outside_hours")); // ends 15:10
      expect(await move(m.M4, MONDAY, "08:50")).toEqual(refused("outside_hours"));
      expect(await move(m.M4, "2026-12-05", "10:00")).toEqual(refused("day_closed")); // a Saturday
      await getDb().update(machines).set({ archivedAt: NOW }).where(eq(machines.id, m.M4));
      expect(await move(m.M4, SUNDAY, "13:00")).toEqual(refused("not_eligible"));

      expect(placementOf(await row(b))).toEqual(placed(SUNDAY, m.M2, "11:00", "11:20"));
      expect(await allNotifications()).toEqual([]);
      expect(await allAudits()).toEqual([]);
    });

    it("the day rules apply when the day changes: two large jobs on Monday already", async () => {
      const big = await on(SUNDAY, m.M3, "09:00", "10:10", JOB_LARGE);
      await busyFor(MONDAY, m.M3, "09:00", "10:10", JOB_LARGE);
      await busyFor(MONDAY, m.M4, "09:00", "10:20", JOB_LARGE);
      actAs("admin");
      expect(await moveBooking({ bookingId: big, machineId: m.M3, startsAt: at(MONDAY, "11:00") })).toEqual({
        ok: false,
        error: "slot_taken",
        reason: "large_job_limit",
      });
      // Same day: its own place in Sunday's count is not counted twice.
      expect(await moveBooking({ bookingId: big, machineId: m.M4, startsAt: at(SUNDAY, "11:00") })).toEqual({
        ok: true,
        booking: { id: big, reference: ref(1), ...placed(SUNDAY, m.M4, "11:00", "12:20") },
      });
    });

    it("an in_progress job may keep a past start; other statuses, bad input and other roles are refused", async () => {
      await setNow(at(SUNDAY, "10:15"));
      const running = await on(SUNDAY, m.M1, "10:00", "10:20", {}, "in_progress");
      const booked = await on(SUNDAY, m.M1, "10:30", "10:50");
      const ready = await on(SUNDAY, m.M2, "09:00", "09:10", {}, "ready");
      const cancelled = await on(SUNDAY, m.M2, "13:00", "13:10", {}, "cancelled");
      actAs("admin");

      expect(await moveBooking({ bookingId: running, machineId: m.M4, startsAt: at(SUNDAY, "10:00") })).toMatchObject({
        ok: true,
        booking: placed(SUNDAY, m.M4, "10:00", "10:10"),
      });
      expect(await moveBooking({ bookingId: booked, machineId: m.M4, startsAt: at(SUNDAY, "10:10") })).toEqual({
        ok: false,
        error: "slot_taken",
        reason: "past",
      });
      for (const id of [ready, cancelled]) {
        expect(await moveBooking({ bookingId: id, machineId: m.M4, startsAt: at(SUNDAY, "13:00") })).toEqual({
          ok: false,
          error: "refused",
        });
      }
      expect(await moveBooking({ bookingId: 9999, machineId: m.M4, startsAt: at(SUNDAY, "13:00") })).toEqual({
        ok: false,
        error: "not_found",
      });
      expect(await moveBooking({ bookingId: booked, machineId: m.M4, startsAt: at(SUNDAY, "13:05") })).toEqual({
        ok: false,
        error: "validation",
      }); // off the grid
      expect(
        await moveBooking({ bookingId: booked, machineId: m.M4, startsAt: at(SUNDAY, "13:00"), endsAt: at(SUNDAY, "14:00") }),
      ).toEqual({ ok: false, error: "validation" });

      for (const name of ["operator", "collegeA"] as const) {
        actAs(name);
        await expect(moveBooking({ bookingId: booked, machineId: m.M4, startsAt: at(SUNDAY, "13:00") })).rejects.toBeInstanceOf(
          AuthError,
        );
      }
    });

    it("a rival that slipped past the lock: the try is rolled back and the next one answers busy", async () => {
      const b = await on(SUNDAY, m.M1, "11:00", "11:20");
      const attempts: number[] = [];
      const result = await moveBookingFor(
        actor("admin"),
        { bookingId: b, machineId: m.M4, startsAt: at(SUNDAY, "13:00") },
        {
          async beforePlacementUpdate(placement, attempt) {
            attempts.push(attempt);
            if (attempt === 0) await busyFor(SUNDAY, placement.machineId, "13:00", "13:10");
          },
        },
      );
      expect(attempts).toEqual([0]);
      expect(result).toEqual({ ok: false, error: "slot_taken", reason: "busy" });
      expect(placementOf(await row(b))).toEqual(placed(SUNDAY, m.M1, "11:00", "11:20"));
    });
  });

  // ---- archive and edit of a machine (§3.8 last bullet)

  describe("archiveMachine and updateMachine", () => {
    it("archive: future booked bookings move at the same start or are flagged machine_change; unarchive restores nothing", async () => {
      const { b1, b2, b3 } = await contractExample();
      const past = await on(SATURDAY, m.M2, "09:00", "09:20", JOB_500); // started before now
      actAs("admin");

      expect(await archiveMachine({ machineId: m.M2 })).toEqual({
        ok: true,
        moved: [
          { id: b1, reference: ref(1) },
          { id: b3, reference: ref(3) },
        ],
        flagged: [{ id: b2, reference: ref(2) }],
      });
      expect(placementOf(await row(b1))).toEqual(placed(SUNDAY, m.M3, "10:10", "10:40"));
      expect(placementOf(await row(b3))).toEqual(placed(SUNDAY, m.M3, "13:00", "13:30"));
      expect(await flagOf(b2)).toEqual({ needsReschedule: true, rescheduleReason: "machine_change" });
      expect((await row(past)).machineId).toBe(m.M2);
      expect((await allNotifications()).map((n) => [n.userId, n.type, n.bookingId])).toEqual([
        [ids.collegeA, "booking_needs_reschedule", b2],
        [ids.admin, "booking_needs_reschedule", b2],
      ]);

      expect(await unarchiveMachine({ machineId: m.M2 })).toEqual({ ok: true, moved: [], flagged: [] });
      expect(await flagOf(b2)).toEqual({ needsReschedule: true, rescheduleReason: "machine_change" });
    });

    it("edit: duplex removed → duplex bookings move or are flagged; a single-sided one stays", async () => {
      const big = await on(SUNDAY, m.M4, "09:00", "09:20", JOB_900_DUPLEX);
      const small = await on(SUNDAY, m.M4, "11:00", "11:10", JOB_300_DUPLEX);
      const single = await on(SUNDAY, m.M4, "12:00", "12:10");
      actAs("admin");

      const fields = {
        name: "M4",
        model: "x",
        type: "laser",
        minSheets: 801,
        maxSheets: null,
        supportsDuplex: false,
        speedPerHour: 6000,
        setupMinutesPerModel: 5,
        priority: 2,
      };
      expect(await updateMachine({ machineId: m.M4, fields })).toEqual({
        ok: true,
        moved: [{ id: small, reference: ref(2) }],
        flagged: [{ id: big, reference: ref(1) }],
      });
      expect(placementOf(await row(small))).toEqual(placed(SUNDAY, m.M1, "11:00", "11:20"));
      expect(await flagOf(big)).toEqual({ needsReschedule: true, rescheduleReason: "machine_change" });
      expect(placementOf(await row(single))).toEqual(placed(SUNDAY, m.M4, "12:00", "12:10"));
      const moves = (await allAudits()).filter((a) => a.action === "booking.auto_move");
      expect(moves.map((a) => (a.details as { cause: string }).cause)).toEqual(["machine_change"]);
    });
  });
});
