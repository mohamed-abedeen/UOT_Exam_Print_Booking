// Step 2.6 — Saturday requests (contracts §1.8, §3.4, §4 "Saturday"): request, approve / reject, and the date opened
// for that college only, up to the approved quantity. Skipped when DATABASE_URL is not set.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, bookings, colleges, holidays, machines, notifications, saturdayRequests, settings, users } from "@/db/schema";
import { createBooking, getAvailability, moveBooking } from "@/lib/actions/bookings";
import { createSaturdayRequest, decideSaturdayRequest, listSaturdayRequests } from "@/lib/actions/saturday";
import { AuthError, SESSION_COOKIE } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import { atMinutes } from "@/lib/scheduling/time";
import type { BookingStatus } from "@/lib/scheduling/types";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const SUNDAY = "2026-11-29";
const SAT = "2026-12-05"; // the next Saturday
const SAT2 = "2026-12-12";
const LAST_SAT = "2026-11-28"; // yesterday
const at = (date: string, hhmm: string) => atMinutes(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const NOW = at(SUNDAY, "09:45");

const NAMES = ["admin", "admin2", "operator", "collegeA", "collegeB"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 2.6: Saturday requests", () => {
  const tokens = {} as Record<Name, string>;
  const ids = {} as Record<Name, number>;
  const collegeIds = {} as { A: number; B: number };
  const m = {} as { M1: number; M2: number; M3: number; M4: number };
  let seq = 0;

  function actAs(name: Name) {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  }
  /** Moves the clock; the sessions are renewed so they do not expire on the jump. */
  async function jumpTo(when: Date) {
    vi.setSystemTime(when);
    for (const name of NAMES) {
      tokens[name] = (await createSession(getDb(), ids[name], { ip: null, userAgent: null }, new Date())).token;
    }
  }

  const request = (over: Record<string, unknown> = {}) => ({
    date: SAT,
    expectedQuantity: 5000,
    reason: "امتحانات نهاية الفصل",
    ...over,
  });
  /** College A files, the admin approves `quantity`. Returns the request id. */
  async function approved(quantity: number, date = SAT): Promise<number> {
    actAs("collegeA");
    const created = await createSaturdayRequest(request({ date }));
    if (!created.ok) throw new Error("create failed");
    actAs("admin");
    expect(await decideSaturdayRequest({ requestId: created.request.id, decision: "approve", approvedQuantity: quantity }))
      .toMatchObject({ ok: true });
    return created.request.id;
  }

  /** A booking written straight into the table. Default: college A, 1 × 2 × 150 single = 300 impressions. */
  async function insertBooking(
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
        ...(status === "cancelled" ? { cancelledAt: NOW, cancelledBy: ids.admin } : {}),
        ...over,
      })
      .returning({ id: bookings.id });
    return row.id;
  }

  const job = (over: Record<string, unknown> = {}) => ({
    copies: 150,
    models: 1,
    pagesPerModel: 2,
    sides: "single",
    date: SAT,
    hour: 10,
    ...over,
  });
  const form = (over: Record<string, unknown> = {}) => ({
    doctorName: "د. أحمد سالم",
    doctorPhone: "0912345678",
    recipientName: "محمد علي حسن الطرابلسي",
    subject: "مادة",
    serviceType: "exam_questions",
    examDate: null,
    ...job(over),
  });
  const exact = (machineId: number, date: string, from: string, to: string) => ({
    ok: true,
    availability: { kind: "exact", placement: { machineId, startsAt: at(date, from), endsAt: at(date, to) } },
  });
  const requestRow = async (id: number) =>
    (await getDb().select().from(saturdayRequests).where(eq(saturdayRequests.id, id)))[0];
  const allNotifications = () => getDb().select().from(notifications).orderBy(notifications.id);

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
        { ...base, username: "admin2", role: "admin", fullName: "مسؤول ٢" },
        { ...base, username: "operator", role: "operator", fullName: "فني" },
        { ...base, username: "collegeA", role: "college", fullName: "منسق أ", collegeId: a.id },
        { ...base, username: "collegeB", role: "college", fullName: "منسق ب", collegeId: b.id },
      ])
      .returning({ id: users.id });
    for (const [i, name] of NAMES.entries()) {
      ids[name] = userRows[i].id;
      tokens[name] = (await createSession(db, userRows[i].id, { ip: null, userAgent: null }, new Date())).token;
    }
    // Not a recipient of anything.
    await db.insert(users).values({ ...base, username: "old-admin", role: "admin", fullName: "سابق", isActive: false });

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

  describe("createSaturdayRequest", () => {
    it("files a pending request for the session's college and tells each active admin", async () => {
      actAs("collegeA");
      const result = await createSaturdayRequest(request({ reason: "  امتحانات  " }));
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(await requestRow(result.request.id)).toMatchObject({
        collegeId: collegeIds.A,
        date: SAT,
        expectedQuantity: 5000,
        reason: "امتحانات",
        status: "pending",
        approvedQuantity: null,
        decidedAt: null,
        createdBy: ids.collegeA,
      });
      const sent = await allNotifications();
      expect(sent.map((n) => n.userId).sort()).toEqual([ids.admin, ids.admin2].sort());
      for (const n of sent) {
        expect(n).toMatchObject({
          type: "saturday_requested",
          bookingId: null,
          saturdayRequestId: result.request.id,
          data: { date: SAT, collegeName: "كلية أ", expectedQuantity: 5000 },
        });
      }
      expect(await getDb().select().from(auditLog)).toHaveLength(0); // only the decision is audited
    });

    it("refuses a date that is not a future Saturday", async () => {
      actAs("collegeA");
      for (const date of ["2026-12-04", "2026-12-06", LAST_SAT, "2026-02-30", "05-12-2026"]) {
        expect(await createSaturdayRequest(request({ date }))).toEqual({ ok: false, error: "validation" });
      }
      await jumpTo(at(SAT, "08:00")); // today is that Saturday: too late
      actAs("collegeA");
      expect(await createSaturdayRequest(request())).toEqual({ ok: false, error: "validation" });
      expect(await getDb().select().from(saturdayRequests)).toHaveLength(0);
    });

    it("refuses a holiday, and a Saturday that is already a working weekday", async () => {
      await getDb().insert(holidays).values({ date: SAT, name: "عيد", createdBy: ids.admin });
      actAs("collegeA");
      expect(await createSaturdayRequest(request())).toEqual({ ok: false, error: "validation" });
      expect(await createSaturdayRequest(request({ date: SAT2 }))).toMatchObject({ ok: true });

      await getDb().update(settings).set({ value: [0, 1, 2, 3, 4, 6] }).where(eq(settings.key, "working_weekdays"));
      expect(await createSaturdayRequest(request({ date: "2026-12-19" }))).toEqual({ ok: false, error: "validation" });
    });

    it("refuses bad fields and a collegeId in the request", async () => {
      actAs("collegeA");
      for (const bad of [
        { expectedQuantity: 0 },
        { expectedQuantity: 1.5 },
        { expectedQuantity: 2_147_483_648 },
        { reason: "   " },
        { reason: "x".repeat(501) },
        { reason: "a\u0000b" },
        { collegeId: collegeIds.B },
        { status: "approved" },
      ]) {
        expect(await createSaturdayRequest(request(bad))).toEqual({ ok: false, error: "validation" });
      }
      expect(await createSaturdayRequest(undefined)).toEqual({ ok: false, error: "validation" });
    });

    it("one open request per college and date; a new one after a rejection; other colleges are independent", async () => {
      actAs("collegeA");
      const first = await createSaturdayRequest(request());
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(await createSaturdayRequest(request({ expectedQuantity: 100 }))).toEqual({ ok: false, error: "duplicate" });

      actAs("collegeB");
      expect(await createSaturdayRequest(request())).toMatchObject({ ok: true });

      actAs("admin");
      await decideSaturdayRequest({ requestId: first.request.id, decision: "approve", approvedQuantity: 3000 });
      actAs("collegeA");
      expect(await createSaturdayRequest(request())).toEqual({ ok: false, error: "duplicate" }); // approved is open

      await getDb().update(saturdayRequests).set({ date: SAT2 }).where(eq(saturdayRequests.id, first.request.id));
      const second = await createSaturdayRequest(request());
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      actAs("admin");
      await decideSaturdayRequest({ requestId: second.request.id, decision: "reject" });
      actAs("collegeA");
      expect(await createSaturdayRequest(request())).toMatchObject({ ok: true }); // after a rejection
    });

    it("the admin and the operator cannot file one", async () => {
      for (const name of ["admin", "operator"] as const) {
        actAs(name);
        await expect(createSaturdayRequest(request())).rejects.toBeInstanceOf(AuthError);
      }
      expect(await getDb().select().from(saturdayRequests)).toHaveLength(0);
    });
  });

  describe("decideSaturdayRequest", () => {
    async function pending(date = SAT): Promise<number> {
      actAs("collegeA");
      const r = await createSaturdayRequest(request({ date }));
      if (!r.ok) throw new Error("create failed");
      await getDb().delete(notifications);
      actAs("admin");
      return r.request.id;
    }

    it("approves with a quantity, tells the college and audits it", async () => {
      const id = await pending();
      expect(
        await decideSaturdayRequest({ requestId: id, decision: "approve", approvedQuantity: 6000, note: "  " }),
      ).toEqual({ ok: true, request: { id, status: "approved" } });
      expect(await requestRow(id)).toMatchObject({
        status: "approved",
        approvedQuantity: 6000, // more than expected is allowed
        decidedBy: ids.admin,
        decidedAt: NOW,
        decisionNote: null, // blank = none
      });
      expect(await allNotifications()).toEqual([
        expect.objectContaining({
          userId: ids.collegeA,
          type: "saturday_decided",
          saturdayRequestId: id,
          data: { date: SAT, status: "approved", approvedQuantity: 6000, note: null },
        }),
      ]);
      expect(await getDb().select().from(auditLog)).toEqual([
        expect.objectContaining({
          userId: ids.admin,
          action: "saturday.decide",
          entity: "saturday_requests",
          entityId: String(id),
          collegeId: collegeIds.A,
          details: { date: SAT, expectedQuantity: 5000, status: "approved", approvedQuantity: 6000, note: null },
        }),
      ]);
    });

    it("rejects with an optional note", async () => {
      const id = await pending();
      expect(await decideSaturdayRequest({ requestId: id, decision: "reject", note: " لا يوجد فنيون " })).toEqual({
        ok: true,
        request: { id, status: "rejected" },
      });
      expect(await requestRow(id)).toMatchObject({ status: "rejected", approvedQuantity: null, decisionNote: "لا يوجد فنيون" });
      expect(await allNotifications()).toEqual([
        expect.objectContaining({
          type: "saturday_decided",
          data: { date: SAT, status: "rejected", approvedQuantity: null, note: "لا يوجد فنيون" },
        }),
      ]);
    });

    it("decides once: a decided request is refused and nothing changes", async () => {
      const id = await pending();
      await decideSaturdayRequest({ requestId: id, decision: "approve", approvedQuantity: 3000 });
      for (const again of [
        { requestId: id, decision: "approve", approvedQuantity: 9000 },
        { requestId: id, decision: "reject" },
      ]) {
        expect(await decideSaturdayRequest(again)).toEqual({ ok: false, error: "refused" });
      }
      expect(await requestRow(id)).toMatchObject({ status: "approved", approvedQuantity: 3000 });
      expect(await getDb().select().from(auditLog)).toHaveLength(1);
    });

    it("a request whose date has passed is refused; on the day itself it can still be decided", async () => {
      const id = await pending();
      const [old] = await getDb()
        .insert(saturdayRequests)
        .values({ collegeId: collegeIds.A, date: LAST_SAT, expectedQuantity: 100, reason: "x", createdBy: ids.collegeA })
        .returning({ id: saturdayRequests.id });
      expect(await decideSaturdayRequest({ requestId: old.id, decision: "reject" })).toEqual({
        ok: false,
        error: "refused",
      });
      await jumpTo(at(SAT, "08:00"));
      actAs("admin");
      expect(await decideSaturdayRequest({ requestId: id, decision: "reject" })).toMatchObject({ ok: true });
    });

    it("not_found and validation", async () => {
      const id = await pending();
      expect(await decideSaturdayRequest({ requestId: id + 99, decision: "reject" })).toEqual({
        ok: false,
        error: "not_found",
      });
      for (const bad of [
        { requestId: id, decision: "approve" },
        { requestId: id, decision: "approve", approvedQuantity: 0 },
        { requestId: id, decision: "reject", approvedQuantity: 100 },
        { requestId: id, decision: "maybe" },
        { requestId: id, decision: "reject", note: "x".repeat(501) },
        { requestId: "1", decision: "reject" },
      ]) {
        expect(await decideSaturdayRequest(bad)).toEqual({ ok: false, error: "validation" });
      }
      expect(await requestRow(id)).toMatchObject({ status: "pending" });
    });

    it("only the admin decides", async () => {
      const id = await pending();
      for (const name of ["collegeA", "operator"] as const) {
        actAs(name);
        await expect(decideSaturdayRequest({ requestId: id, decision: "reject" })).rejects.toBeInstanceOf(AuthError);
      }
      expect(await requestRow(id)).toMatchObject({ status: "pending" });
    });
  });

  describe("listSaturdayRequests", () => {
    it("a college sees its own rows, newest date first; the admin sees all and may filter", async () => {
      const a1 = await approved(1000, SAT);
      actAs("collegeA");
      const a2 = await createSaturdayRequest(request({ date: SAT2 }));
      actAs("collegeB");
      const b1 = await createSaturdayRequest(request({ date: SAT }));
      if (!a2.ok || !b1.ok) throw new Error("create failed");
      // Used impressions: holding rows of college A that day; a cancelled one and college B's do not count.
      await insertBooking(m.M1, at(SAT, "09:00"), at(SAT, "09:20"));
      await insertBooking(m.M1, at(SAT, "10:00"), at(SAT, "10:20"), {}, "cancelled");
      await insertBooking(m.M2, at(SAT, "09:00"), at(SAT, "09:10"), { collegeId: collegeIds.B, createdBy: ids.collegeB });

      actAs("collegeA");
      const own = await listSaturdayRequests();
      expect(own.ok && own.items.map((r) => r.id)).toEqual([a2.request.id, a1]);
      expect(own.ok && own.items[1]).toMatchObject({
        collegeName: "كلية أ",
        status: "approved",
        approvedQuantity: 1000,
        usedImpressions: 300,
        decidedByName: "مسؤول",
      });
      expect(own.ok && own.items[0]).toMatchObject({ status: "pending", usedImpressions: null, decidedByName: null });
      await expect(listSaturdayRequests({ collegeId: collegeIds.B })).rejects.toBeInstanceOf(AuthError);

      actAs("admin");
      const all = await listSaturdayRequests();
      expect(all.ok && all.items.map((r) => r.id)).toEqual([a2.request.id, b1.request.id, a1]);
      const pendingB = await listSaturdayRequests({ collegeId: collegeIds.B, status: "pending" });
      expect(pendingB.ok && pendingB.items.map((r) => r.id)).toEqual([b1.request.id]);
      expect(await listSaturdayRequests({ status: "open" })).toEqual({ ok: false, error: "validation" });

      actAs("operator");
      await expect(listSaturdayRequests()).rejects.toBeInstanceOf(AuthError);
    });
  });

  describe("the approved date opens for that college only, up to the quantity", () => {
    it("pending or rejected: still closed", async () => {
      actAs("collegeA");
      const r = await createSaturdayRequest(request());
      expect(await getAvailability(job())).toMatchObject({ availability: { kind: "suggestion", reason: "day_closed" } });
      if (!r.ok) return;
      actAs("admin");
      await decideSaturdayRequest({ requestId: r.request.id, decision: "reject" });
      actAs("collegeA");
      expect(await getAvailability(job())).toMatchObject({ availability: { kind: "suggestion", reason: "day_closed" } });
    });

    it("approved: college A books inside the quota; college B stays closed; the quota counts impressions", async () => {
      await approved(500);
      actAs("collegeA");
      expect(await getAvailability(job())).toEqual(exact(m.M1, SAT, "10:00", "10:20"));
      const first = await createBooking(form());
      expect(first).toMatchObject({ ok: true });

      // 300 used + 300 > 500: the next job is refused on that day.
      expect(await getAvailability(job({ hour: 11 }))).toMatchObject({
        availability: { kind: "suggestion", reason: "saturday_quota" },
      });
      expect(await getAvailability(job({ hour: 11, copies: 100 }))).toEqual(exact(m.M1, SAT, "11:00", "11:10")); // 200 fits

      actAs("collegeB");
      expect(await getAvailability(job())).toMatchObject({ availability: { kind: "suggestion", reason: "day_closed" } });

      actAs("admin"); // on behalf of B: B's context, closed too; on behalf of A: A's quota
      expect(await getAvailability({ ...job(), collegeId: collegeIds.B })).toMatchObject({
        availability: { reason: "day_closed" },
      });
      expect(await getAvailability({ ...job({ hour: 11 }), collegeId: collegeIds.A })).toMatchObject({
        availability: { reason: "saturday_quota" },
      });
    });

    it("a cancelled booking frees its quota; an edited booking does not count itself", async () => {
      await approved(300);
      await insertBooking(m.M1, at(SAT, "09:00"), at(SAT, "09:20"), {}, "cancelled");
      const held = await insertBooking(m.M1, at(SAT, "12:00"), at(SAT, "12:20"));
      actAs("collegeA");
      expect(await getAvailability(job())).toMatchObject({ availability: { reason: "saturday_quota" } });
      expect(await getAvailability({ ...job(), bookingId: held })).toEqual(exact(m.M1, SAT, "10:00", "10:20"));
    });

    it("a holiday added later closes the approved Saturday too", async () => {
      await approved(5000);
      await getDb().insert(holidays).values({ date: SAT, name: "عيد", createdBy: ids.admin });
      actAs("collegeA");
      expect(await getAvailability(job())).toMatchObject({ availability: { reason: "day_closed" } });
    });

    it("an admin move of a Saturday booking uses that college's approval", async () => {
      await approved(300);
      const held = await insertBooking(m.M1, at(SAT, "10:00"), at(SAT, "10:20"));
      actAs("admin");
      expect(await moveBooking({ bookingId: held, machineId: m.M2, startsAt: at(SAT, "11:00") })).toMatchObject({
        ok: true,
        booking: { machineId: m.M2, startsAt: at(SAT, "11:00") },
      });
      const other = await insertBooking(m.M1, at(SAT, "09:00"), at(SAT, "09:20"), {
        collegeId: collegeIds.B,
        createdBy: ids.collegeB,
      });
      expect(await moveBooking({ bookingId: other, machineId: m.M1, startsAt: at(SAT, "12:00") })).toEqual({
        ok: false,
        error: "slot_taken",
        reason: "day_closed",
      });
    });
  });
});
