// Step 2.3 — edit, cancel, delay notice (contracts §2 T5 / T6, §3.7, §4): the 60-minute rules, the move to the
// latest free interval, the fallback to the admin list. Skipped when DATABASE_URL is not set.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, bookings, colleges, machines, notifications, settings, users } from "@/db/schema";
import {
  cancelBooking,
  editBooking,
  getAvailability,
  listNeedsReschedule,
  sendDelayNotice,
} from "@/lib/actions/bookings";
import { AuthError, SESSION_COOKIE, type Actor } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import { editBookingFor } from "@/lib/bookings/change";
import { atMinutes } from "@/lib/scheduling/time";
import type { BookingStatus, Placement } from "@/lib/scheduling/types";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const SUNDAY = "2026-11-29";
const at = (date: string, hhmm: string) => atMinutes(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const NOW = at(SUNDAY, "09:45");
const SECOND = 1000;

const NAMES = ["admin", "operator", "collegeA", "collegeB"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 2.3: edit, cancel, delay notice", () => {
  const tokens = {} as Record<Name, string>;
  const ids = {} as Record<Name, number>;
  const collegeIds = {} as { A: number; B: number };
  const m = {} as { M1: number; M2: number; M3: number; M4: number };
  let seq = 0;

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

  /**
   * A row written straight into the table. Default: college A, 1 × 2 × 150 single (300 impressions: 20 min on M1
   * and M3, 10 min on M2 and M4). College B's rows stand for "the machine is busy".
   */
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
  const busyFor = (machineId: number, from: string, to: string) =>
    insert(machineId, at(SUNDAY, from), at(SUNDAY, to), { collegeId: collegeIds.B, createdBy: ids.collegeB });

  const row = async (id: number) => (await getDb().select().from(bookings).where(eq(bookings.id, id)))[0];
  const allNotifications = () => getDb().select().from(notifications).orderBy(notifications.id);
  const allAudits = () => getDb().select().from(auditLog).orderBy(auditLog.id);

  const editForm = (bookingId: number, over: Record<string, unknown> = {}) => ({
    bookingId,
    doctorName: "د. أحمد سالم",
    doctorPhone: "218912345678",
    recipientName: "محمد علي حسن الطرابلسي",
    subject: "مادة",
    serviceType: "exam_questions",
    copies: 150,
    models: 1,
    pagesPerModel: 2,
    sides: "single",
    examDate: null,
    date: SUNDAY,
    hour: 11,
    ...over,
  });
  const placementOf = (r: { machineId: number; startsAt: Date; endsAt: Date }) => ({
    machineId: r.machineId,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
  });
  const placed = (machineId: number, from: string, to: string): Placement => ({
    machineId,
    startsAt: at(SUNDAY, from),
    endsAt: at(SUNDAY, to),
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

  // ---- cancelBooking (T5, T6)

  describe("cancelBooking", () => {
    it("college: own booked booking until 60 minutes before the start, not one second later", async () => {
      const b1 = await insert(m.M1, at(SUNDAY, "10:50"), at(SUNDAY, "11:10"));
      const b2 = await insert(m.M2, at(SUNDAY, "10:50"), at(SUNDAY, "11:00"));
      actAs("collegeA");

      vi.setSystemTime(at(SUNDAY, "09:50")); // exactly 60 minutes before
      expect(await cancelBooking({ bookingId: b1 })).toMatchObject({ ok: true, booking: { id: b1, status: "cancelled" } });
      expect(await row(b1)).toMatchObject({
        status: "cancelled",
        cancelledBy: ids.collegeA,
        cancelledAt: at(SUNDAY, "09:50"),
        cancelReason: null,
      });

      vi.setSystemTime(at(SUNDAY, "09:50").getTime() + SECOND);
      const before = await row(b2);
      expect(await cancelBooking({ bookingId: b2, reason: "تأجيل" })).toEqual({ ok: false, error: "refused" });
      expect(await row(b2)).toEqual(before);

      // A college cancel is neither audited nor notified.
      expect(await allAudits()).toEqual([]);
      expect(await allNotifications()).toEqual([]);
    });

    it("college: another college's booking is not found; in_progress is refused; an operator may not cancel", async () => {
      const other = await insert(m.M1, at(SUNDAY, "13:00"), at(SUNDAY, "13:20"), { collegeId: collegeIds.B });
      const started = await insert(m.M2, at(SUNDAY, "13:00"), at(SUNDAY, "13:10"), {}, "in_progress");
      actAs("collegeA");
      expect(await cancelBooking({ bookingId: other })).toEqual({ ok: false, error: "not_found" });
      expect(await cancelBooking({ bookingId: 999_999 })).toEqual({ ok: false, error: "not_found" });
      expect(await cancelBooking({ bookingId: started, reason: "خطأ" })).toEqual({ ok: false, error: "refused" });
      expect((await row(other)).status).toBe("booked");
      expect((await row(started)).status).toBe("in_progress");

      actAs("operator");
      await expect(cancelBooking({ bookingId: started })).rejects.toBeInstanceOf(AuthError);
    });

    it("admin: booked at any time; in_progress only with a reason; audited and the college told", async () => {
      const late = await insert(m.M1, at(SUNDAY, "09:00"), at(SUNDAY, "09:20")); // start already passed
      const started = await insert(m.M2, at(SUNDAY, "09:30"), at(SUNDAY, "09:40"), {}, "in_progress");
      actAs("admin");

      expect(await cancelBooking({ bookingId: late })).toMatchObject({ ok: true, booking: { status: "cancelled" } });
      expect(await cancelBooking({ bookingId: started })).toEqual({ ok: false, error: "refused" });
      expect(await cancelBooking({ bookingId: started, reason: "   " })).toEqual({ ok: false, error: "refused" });
      expect((await row(started)).status).toBe("in_progress");
      expect(await cancelBooking({ bookingId: started, reason: "الآلة لا تكمل" })).toMatchObject({ ok: true });
      expect(await row(started)).toMatchObject({ status: "cancelled", cancelledBy: ids.admin, cancelReason: "الآلة لا تكمل" });

      expect((await allAudits()).map((a) => [a.action, Number(a.entityId)])).toEqual([
        ["booking.admin_cancel", late],
        ["booking.admin_cancel", started],
      ]);
      expect((await allNotifications()).map((n) => [n.userId, n.type, n.bookingId])).toEqual([
        [ids.collegeA, "booking_cancelled", late],
        [ids.collegeA, "booking_cancelled", started],
      ]);
    });

    it("admin: ready, delivered, cancelled and no_show stay as they are", async () => {
      actAs("admin");
      for (const [i, status] of (["ready", "delivered", "cancelled", "no_show"] as const).entries()) {
        const id = await insert(m.M1, atMinutes(SUNDAY, i * 10), atMinutes(SUNDAY, i * 10 + 10), {}, status);
        const before = await row(id);
        expect(await cancelBooking({ bookingId: id, reason: "سبب" }), status).toEqual({ ok: false, error: "refused" });
        expect(await row(id), status).toEqual(before);
      }
    });

    it("clears a reschedule flag and releases the interval", async () => {
      const id = await insert(m.M1, at(SUNDAY, "13:00"), at(SUNDAY, "13:20"), {
        needsReschedule: true,
        rescheduleReason: "maintenance",
      });
      actAs("admin");
      expect(await cancelBooking({ bookingId: id })).toMatchObject({ ok: true });
      expect(await row(id)).toMatchObject({ needsReschedule: false, rescheduleReason: null });
      await busyFor(m.M1, "13:00", "13:20"); // no overlap error: the row left bookings_no_overlap
    });
  });

  // ---- editBooking (§3.7)

  describe("editBooking", () => {
    it("form fields only: a plain update, same placement and reference, phone normalised, not audited", async () => {
      const id = await insert(m.M1, at(SUNDAY, "11:00"), at(SUNDAY, "11:20"));
      actAs("collegeA");
      const result = await editBooking(editForm(id, { subject: "فيزياء 2", doctorPhone: "092-1234567" }));
      expect(result).toEqual({ ok: true, booking: { id, reference: "2026-0001" }, examDateWarning: false });
      expect(await row(id)).toMatchObject({
        ...placed(m.M1, "11:00", "11:20"),
        subject: "فيزياء 2",
        doctorPhone: "218921234567",
        reference: "2026-0001",
      });
      expect(await allAudits()).toEqual([]);
    });

    it("a changed job is placed again without the booking itself in the way", async () => {
      // 1 × 2 × 100 = 200 impressions, 10 min on M1. With 200 copies it needs 20 min: its own slot counts as free.
      const id = await insert(m.M1, at(SUNDAY, "11:00"), at(SUNDAY, "11:10"), { copies: 100 });
      actAs("collegeA");
      expect(await editBooking(editForm(id, { copies: 200 }))).toMatchObject({ ok: true, booking: { id } });
      expect(await row(id)).toMatchObject({ ...placed(m.M1, "11:00", "11:20"), copies: 200, impressions: 400 });
    });

    it("another hour: placed there; a full hour returns a suggestion that is written only when accepted", async () => {
      const id = await insert(m.M1, at(SUNDAY, "11:00"), at(SUNDAY, "11:20"), {
        needsReschedule: true,
        rescheduleReason: "maintenance",
      });
      for (const machineId of [m.M1, m.M2, m.M3, m.M4]) await busyFor(machineId, "12:00", "13:00");
      actAs("collegeA");

      const before = await row(id);
      const full = await editBooking(editForm(id, { hour: 12 }));
      expect(full).toMatchObject({ ok: false, error: "needs_confirmation", availability: { kind: "suggestion", reason: "hour_full" } });
      expect(await row(id)).toEqual(before);

      // Nearest to 12:00: M2 11:50 (10 minutes before; M4 too, but tier group 401 first), ahead of M1 11:40.
      if (full.ok || full.availability?.kind !== "suggestion") throw new Error("expected a suggestion");
      expect(full.availability.placement).toEqual(placed(m.M2, "11:50", "12:00"));
      const accepted = await editBooking(editForm(id, { hour: 12, accept: full.availability.placement }));
      expect(accepted).toMatchObject({ ok: true, booking: { id, reference: "2026-0001" } });
      expect(await row(id)).toMatchObject({
        ...placed(m.M2, "11:50", "12:00"),
        needsReschedule: false,
        rescheduleReason: null,
      });

      expect(await editBooking(editForm(id, { hour: 13 }))).toMatchObject({ ok: true });
      expect(placementOf(await row(id))).toEqual(placed(m.M1, "13:00", "13:20"));
    });

    it("college: until 60 minutes before the start; not after, not another college's, not once started", async () => {
      const b1 = await insert(m.M1, at(SUNDAY, "11:00"), at(SUNDAY, "11:20"));
      const b2 = await insert(m.M2, at(SUNDAY, "11:00"), at(SUNDAY, "11:10"));
      const other = await insert(m.M3, at(SUNDAY, "13:00"), at(SUNDAY, "13:20"), { collegeId: collegeIds.B });
      const started = await insert(m.M4, at(SUNDAY, "13:00"), at(SUNDAY, "13:10"), {}, "in_progress");
      actAs("collegeA");

      vi.setSystemTime(at(SUNDAY, "10:00"));
      expect(await editBooking(editForm(b1, { subject: "جديد" }))).toMatchObject({ ok: true });
      vi.setSystemTime(at(SUNDAY, "10:00").getTime() + SECOND);
      expect(await editBooking(editForm(b2, { subject: "جديد" }))).toEqual({ ok: false, error: "not_editable" });
      expect(await editBooking(editForm(b2, { hour: 14 }))).toEqual({ ok: false, error: "not_editable" });
      expect(await editBooking(editForm(other, { hour: 14 }))).toEqual({ ok: false, error: "not_found" });
      expect(await editBooking(editForm(started, { hour: 14 }))).toEqual({ ok: false, error: "not_editable" });
      expect(await editBooking(editForm(b1, { collegeId: collegeIds.A }))).toEqual({ ok: false, error: "validation" });
      expect((await row(b2)).subject).not.toBe("جديد");

      actAs("operator");
      await expect(editBooking(editForm(b1))).rejects.toBeInstanceOf(AuthError);
    });

    it("admin: any booked booking at any time; audited; booking_rescheduled only when the start changes", async () => {
      const id = await insert(m.M1, at(SUNDAY, "10:00"), at(SUNDAY, "10:20")); // 15 minutes away
      const started = await insert(m.M2, at(SUNDAY, "09:30"), at(SUNDAY, "09:40"), {}, "in_progress");
      actAs("admin");

      // Same start, more copies: 200 copies = 400 impressions, still 20 min on M1.
      expect(await editBooking(editForm(id, { hour: 10, copies: 200 }))).toMatchObject({ ok: true });
      expect(placementOf(await row(id))).toEqual(placed(m.M1, "10:00", "10:20"));
      expect(await allNotifications()).toEqual([]);

      expect(await editBooking(editForm(id, { hour: 14, copies: 200 }))).toMatchObject({ ok: true });
      expect(placementOf(await row(id))).toEqual(placed(m.M1, "14:00", "14:20"));
      expect((await allNotifications()).map((n) => [n.userId, n.type, n.bookingId])).toEqual([
        [ids.collegeA, "booking_rescheduled", id],
      ]);
      expect((await allAudits()).map((a) => [a.action, Number(a.entityId)])).toEqual([
        ["booking.admin_edit", id],
        ["booking.admin_edit", id],
      ]);

      expect(await editBooking(editForm(started, { hour: 14 }))).toEqual({ ok: false, error: "not_editable" });
      expect(await editBooking(editForm(999_999))).toEqual({ ok: false, error: "not_found" });
    });

    it("a rival that slipped past the lock: the try is rolled back and the next one places it elsewhere", async () => {
      const id = await insert(m.M1, at(SUNDAY, "11:00"), at(SUNDAY, "11:20"));
      const seen: { placement: Placement; attempt: number }[] = [];
      const result = await editBookingFor(actor("collegeA"), editForm(id, { hour: 13 }), {
        async beforePlacementUpdate(placement, attempt) {
          seen.push({ placement, attempt });
          if (attempt === 0) await busyFor(placement.machineId, "13:00", "13:20");
        },
      });
      expect(seen.map((s) => s.attempt)).toEqual([0, 1]);
      expect(seen[0].placement).toEqual(placed(m.M1, "13:00", "13:20"));
      expect(result).toMatchObject({ ok: true });
      expect(placementOf(await row(id))).toEqual(placed(m.M1, "13:20", "13:40"));
    });
  });

  // ---- getAvailability for an edit

  describe("getAvailability with bookingId", () => {
    it("leaves the booking itself out; own booked booking only; an admin gets the booking's college", async () => {
      const id = await insert(m.M1, at(SUNDAY, "11:00"), at(SUNDAY, "11:20"));
      const other = await insert(m.M2, at(SUNDAY, "11:00"), at(SUNDAY, "11:10"), { collegeId: collegeIds.B });
      const job = { copies: 150, models: 1, pagesPerModel: 2, sides: "single", date: SUNDAY, hour: 11 };
      actAs("collegeA");

      expect(await getAvailability(job)).toMatchObject({
        ok: true,
        availability: { kind: "exact", placement: placed(m.M1, "11:20", "11:40") },
      });
      expect(await getAvailability({ ...job, bookingId: id })).toEqual({
        ok: true,
        availability: { kind: "exact", placement: placed(m.M1, "11:00", "11:20") },
      });
      expect(await getAvailability({ ...job, bookingId: other })).toEqual({ ok: false, error: "validation" });

      actAs("admin");
      expect(await getAvailability({ ...job, bookingId: id })).toMatchObject({
        ok: true,
        availability: { placement: placed(m.M1, "11:00", "11:20") },
      });
      expect(await getAvailability({ ...job, bookingId: id, collegeId: collegeIds.B })).toEqual({
        ok: false,
        error: "validation",
      });
    });
  });

  // ---- sendDelayNotice (§3.7)

  describe("sendDelayNotice", () => {
    it("contract example: moves to the latest free start that day (M2 14:50), frees 11:00; a second notice is refused", async () => {
      const id = await insert(m.M1, at(SUNDAY, "11:00"), at(SUNDAY, "11:20"));
      await busyFor(m.M1, "14:00", "15:00");
      actAs("collegeA");

      const result = await sendDelayNotice({ bookingId: id });
      expect(result).toEqual({
        ok: true,
        booking: { id, reference: "2026-0001", startsAt: at(SUNDAY, "14:50"), endsAt: at(SUNDAY, "15:00") },
        moved: true,
      });
      expect(await row(id)).toMatchObject({
        ...placed(m.M2, "14:50", "15:00"),
        delayNoticeAt: NOW,
        delayedFrom: at(SUNDAY, "11:00"),
        needsReschedule: false,
      });
      await busyFor(m.M1, "11:00", "11:20"); // the old interval is free again

      expect((await allAudits()).map((a) => [a.action, Number(a.entityId), a.userId])).toEqual([
        ["booking.delay_notice", id, ids.collegeA],
      ]);
      expect(await allNotifications()).toEqual([]);

      const before = await row(id);
      expect(await sendDelayNotice({ bookingId: id })).toEqual({ ok: false, error: "refused" });
      expect(await row(id)).toEqual(before);
    });

    it("no free start later that day: the time stays, flagged delay_no_slot, the admins told, in the admin list", async () => {
      const id = await insert(m.M1, at(SUNDAY, "11:00"), at(SUNDAY, "11:20"));
      await busyFor(m.M1, "11:20", "15:00");
      for (const machineId of [m.M2, m.M3, m.M4]) await busyFor(machineId, "11:10", "15:00");
      actAs("collegeA");

      expect(await sendDelayNotice({ bookingId: id })).toEqual({
        ok: true,
        booking: { id, reference: "2026-0001", startsAt: at(SUNDAY, "11:00"), endsAt: at(SUNDAY, "11:20") },
        moved: false,
      });
      expect(await row(id)).toMatchObject({
        ...placed(m.M1, "11:00", "11:20"),
        delayNoticeAt: NOW,
        delayedFrom: at(SUNDAY, "11:00"),
        needsReschedule: true,
        rescheduleReason: "delay_no_slot",
      });
      expect((await allNotifications()).map((n) => [n.userId, n.type, n.bookingId])).toEqual([
        [ids.admin, "booking_needs_reschedule", id],
      ]);
      expect(await sendDelayNotice({ bookingId: id })).toEqual({ ok: false, error: "refused" }); // notice used up

      await expect(listNeedsReschedule()).rejects.toBeInstanceOf(AuthError);
      actAs("admin");
      expect(await listNeedsReschedule()).toEqual({
        ok: true,
        bookings: [
          {
            id,
            reference: "2026-0001",
            collegeId: collegeIds.A,
            collegeName: "كلية أ",
            machineId: m.M1,
            machineName: "M1",
            startsAt: at(SUNDAY, "11:00"),
            endsAt: at(SUNDAY, "11:20"),
            status: "booked",
            rescheduleReason: "delay_no_slot",
            delayedFrom: at(SUNDAY, "11:00"),
            subject: "مادة 1",
            impressions: 300,
          },
        ],
      });
    });

    it("accepted until 60 minutes before the start, not one second later", async () => {
      const b1 = await insert(m.M1, at(SUNDAY, "11:00"), at(SUNDAY, "11:20"));
      const b2 = await insert(m.M2, at(SUNDAY, "11:00"), at(SUNDAY, "11:10"));
      actAs("collegeA");
      vi.setSystemTime(at(SUNDAY, "10:00"));
      expect(await sendDelayNotice({ bookingId: b1 })).toMatchObject({ ok: true, moved: true });
      vi.setSystemTime(at(SUNDAY, "10:00").getTime() + SECOND);
      const before = await row(b2);
      expect(await sendDelayNotice({ bookingId: b2 })).toEqual({ ok: false, error: "refused" });
      expect(await row(b2)).toEqual(before);
    });

    it("refused when flagged or started; another college's is not found; admin and operator may not send one", async () => {
      const flagged = await insert(m.M1, at(SUNDAY, "13:00"), at(SUNDAY, "13:20"), {
        needsReschedule: true,
        rescheduleReason: "maintenance",
      });
      const started = await insert(m.M2, at(SUNDAY, "13:00"), at(SUNDAY, "13:10"), {}, "in_progress");
      const other = await insert(m.M3, at(SUNDAY, "13:00"), at(SUNDAY, "13:20"), { collegeId: collegeIds.B });
      actAs("collegeA");
      expect(await sendDelayNotice({ bookingId: flagged })).toEqual({ ok: false, error: "refused" });
      expect(await sendDelayNotice({ bookingId: started })).toEqual({ ok: false, error: "refused" });
      expect(await sendDelayNotice({ bookingId: other })).toEqual({ ok: false, error: "not_found" });
      expect((await row(flagged)).delayNoticeAt).toBeNull();

      actAs("admin");
      await expect(sendDelayNotice({ bookingId: flagged })).rejects.toBeInstanceOf(AuthError);
      actAs("operator");
      await expect(sendDelayNotice({ bookingId: flagged })).rejects.toBeInstanceOf(AuthError);
    });
  });
});
