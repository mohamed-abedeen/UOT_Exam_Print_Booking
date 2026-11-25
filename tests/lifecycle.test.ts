// Step 2.1 — booking lifecycle: T2 confirmIdentity, T3 markReady, T4 markDelivered, T7 markNoShow (contracts §2),
// notification rows and reads, getBooking, getWhatsAppLink. Skipped when DATABASE_URL is not set.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, bookings, colleges, machines, notifications, users } from "@/db/schema";
import {
  confirmIdentity,
  getBooking,
  getWhatsAppLink,
  markDelivered,
  markNoShow,
  markReady,
} from "@/lib/actions/bookings";
import { listMyNotifications, markNotificationRead } from "@/lib/actions/notifications";
import { AuthError, SESSION_COOKIE } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import { addDays, atMinutes } from "@/lib/scheduling/time";
import type { BookingStatus } from "@/lib/scheduling/types";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const TODAY = "2026-11-29"; // a Sunday
const NOW = atMinutes(TODAY, 10 * 60 + 5); // 10:05 Tripoli
const at = (date: string, hhmm: string) => atMinutes(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

const NAMES = ["admin", "operator", "collegeA", "collegeAOff", "collegeB"] as const;
type Name = (typeof NAMES)[number];

const STATUSES: BookingStatus[] = ["booked", "in_progress", "ready", "delivered", "cancelled", "no_show"];

/** The columns each status needs to pass the §1.7 CHECKs. */
function statusColumns(status: BookingStatus, userId: number): Partial<typeof bookings.$inferInsert> {
  const t = new Date(NOW.getTime() - 60_000);
  const confirmed = { identityConfirmedAt: t, identityConfirmedBy: userId };
  const readyCols = { ...confirmed, readyAt: t, readyBy: userId, wastedSheets: 0, wasteDestroyed: true };
  switch (status) {
    case "booked":
      return { status };
    case "in_progress":
      return { status, ...confirmed };
    case "ready":
      return { status, ...readyCols };
    case "delivered":
      return { status, ...readyCols, deliveredAt: t, deliveredBy: userId };
    case "cancelled":
      return { status, cancelledAt: t, cancelledBy: userId };
    case "no_show":
      return { status, noShowAt: t, noShowBy: userId };
  }
}

describe.skipIf(!process.env.DATABASE_URL)("step 2.1: booking lifecycle", () => {
  const tokens = {} as Record<Name, string>;
  const ids = {} as Record<Name, number>;
  const collegeIds = {} as { A: number; B: number };
  const m = {} as { M1: number; M2: number };
  let seq = 0;

  function actAs(name: Name) {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  }

  async function insert(
    startsAt: Date,
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
        copies: 100,
        models: 1,
        pagesPerModel: 2,
        sides: "single",
        machineId: m.M1,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 10 * 60_000),
        ...statusColumns(status, ids.operator),
        ...over,
      })
      .returning({ id: bookings.id });
    return row.id;
  }

  const row = async (id: number) => (await getDb().select().from(bookings).where(eq(bookings.id, id)))[0];
  const allNotifications = () => getDb().select().from(notifications).orderBy(notifications.id);
  const allAudits = () => getDb().select().from(auditLog).orderBy(auditLog.id);

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
        // An inactive earlier account of college A: it gets no notification rows (one active per college).
        { ...base, username: "collegeAOff", role: "college", fullName: "منسق موقوف", collegeId: a.id, isActive: false },
        { ...base, username: "collegeB", role: "college", fullName: "منسق ب", collegeId: b.id },
      ])
      .returning({ id: users.id });
    for (const [i, name] of NAMES.entries()) {
      ids[name] = userRows[i].id;
      tokens[name] = (await createSession(db, userRows[i].id, { ip: null, userAgent: null }, new Date())).token;
    }

    const laser = { model: "x", type: "laser" as const, supportsDuplex: true, setupMinutesPerModel: 5, priority: 1 };
    const machineRows = await db
      .insert(machines)
      .values([
        { ...laser, name: "M1", minSheets: 1, maxSheets: 400, speedPerHour: 3000 },
        { ...laser, name: "M2", minSheets: 401, maxSheets: 800, speedPerHour: 4200 },
      ])
      .returning({ id: machines.id });
    Object.assign(m, { M1: machineRows[0].id, M2: machineRows[1].id });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- the "Done when" of step 2.1

  describe("every transition not in contracts §2 is refused", () => {
    const actions = [
      { name: "confirmIdentity", call: confirmIdentity, from: "booked", to: "in_progress", extra: {} },
      { name: "markReady", call: markReady, from: "in_progress", to: "ready", extra: { wastedSheets: 3, wasteDestroyed: true } },
      { name: "markDelivered", call: markDelivered, from: "ready", to: "delivered", extra: {} },
      { name: "markNoShow", call: markNoShow, from: "booked", to: "no_show", extra: {} },
    ] as const;

    for (const action of actions) {
      it(`${action.name}: only ${action.from} → ${action.to}; every other status is left as it was`, async () => {
        actAs("operator");
        for (const [i, status] of STATUSES.entries()) {
          // Today, before now, each in its own slot: the date and start guards hold, only the status differs.
          const id = await insert(atMinutes(TODAY, i * 10), {}, status);
          const before = await row(id);
          const result = await action.call({ bookingId: id, ...action.extra });
          if (status === action.from) {
            expect(result, status).toMatchObject({ ok: true, booking: { id, status: action.to } });
            expect((await row(id)).status).toBe(action.to);
          } else {
            expect(result, status).toEqual({ ok: false, error: "refused" });
            expect(await row(id), status).toEqual(before);
          }
        }
      });
    }

    it("delivered, cancelled and no_show are final: no action moves them", async () => {
      actAs("admin");
      for (const [i, status] of (["delivered", "cancelled", "no_show"] as const).entries()) {
        const id = await insert(atMinutes(TODAY, i * 10), {}, status);
        const before = await row(id);
        for (const call of [confirmIdentity, markDelivered, markNoShow]) {
          expect(await call({ bookingId: id })).toEqual({ ok: false, error: "refused" });
        }
        expect(await markReady({ bookingId: id, wastedSheets: 0, wasteDestroyed: true })).toEqual({
          ok: false,
          error: "refused",
        });
        expect(await row(id)).toEqual(before);
      }
    });
  });

  describe("who may do it", () => {
    it("a college is refused every transition and the WhatsApp link; no session goes to /login", async () => {
      const id = await insert(at(TODAY, "09:00"));
      const calls = [
        () => confirmIdentity({ bookingId: id }),
        () => markReady({ bookingId: id, wastedSheets: 0, wasteDestroyed: true }),
        () => markDelivered({ bookingId: id }),
        () => markNoShow({ bookingId: id }),
        () => getWhatsAppLink({ bookingId: id, kind: "started" }),
      ];
      for (const call of calls) {
        actAs("collegeA");
        await expect(call()).rejects.toBeInstanceOf(AuthError);
        browser.reset();
        await expect(call()).rejects.toMatchObject({ to: "/login" });
      }
      expect((await row(id)).status).toBe("booked");
    });

    it("an operator and an admin may run the whole path", async () => {
      for (const name of ["operator", "admin"] as const) {
        actAs(name);
        const id = await insert(at(TODAY, name === "operator" ? "09:00" : "09:30"));
        expect(await confirmIdentity({ bookingId: id })).toMatchObject({ ok: true });
        expect(await markReady({ bookingId: id, wastedSheets: 0, wasteDestroyed: true })).toMatchObject({ ok: true });
        expect(await markDelivered({ bookingId: id })).toMatchObject({ ok: true, booking: { status: "delivered" } });
        expect(await row(id)).toMatchObject({
          identityConfirmedBy: ids[name],
          readyBy: ids[name],
          deliveredBy: ids[name],
        });
      }
    });

    it("an unknown booking is not found; bad input is refused before anything is read", async () => {
      actAs("operator");
      expect(await confirmIdentity({ bookingId: 999_999 })).toEqual({ ok: false, error: "not_found" });
      expect(await markDelivered({ bookingId: 999_999 })).toEqual({ ok: false, error: "not_found" });
      for (const bad of [undefined, null, {}, { bookingId: "1" }, { bookingId: 0 }, { bookingId: 1.5 }, { bookingId: 1, x: 1 }]) {
        expect(await confirmIdentity(bad)).toEqual({ ok: false, error: "validation" });
        expect(await markNoShow(bad)).toEqual({ ok: false, error: "validation" });
        expect(await markDelivered(bad)).toEqual({ ok: false, error: "validation" });
      }
    });
  });

  describe("T2 confirmIdentity", () => {
    it("records who and when, and audits", async () => {
      const id = await insert(at(TODAY, "10:30")); // a start later today is fine
      actAs("operator");
      expect(await confirmIdentity({ bookingId: id })).toEqual({
        ok: true,
        booking: { id, reference: "2026-0001", status: "in_progress" },
      });
      expect(await row(id)).toMatchObject({
        status: "in_progress",
        identityConfirmedBy: ids.operator,
        identityConfirmedAt: NOW,
        updatedAt: NOW,
      });
      const audits = await allAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        userId: ids.operator,
        role: "operator",
        action: "booking.confirm_identity",
        entity: "bookings",
        entityId: String(id),
        collegeId: collegeIds.A,
        details: { reference: "2026-0001" },
      });
      expect(await allNotifications()).toEqual([]);
    });

    it("only on the booking's own work date", async () => {
      const yesterday = await insert(at(addDays(TODAY, -1), "10:00"));
      const tomorrow = await insert(at(addDays(TODAY, 1), "10:00"));
      actAs("admin");
      expect(await confirmIdentity({ bookingId: yesterday })).toEqual({ ok: false, error: "refused" });
      expect(await confirmIdentity({ bookingId: tomorrow })).toEqual({ ok: false, error: "refused" });
      expect((await row(tomorrow)).status).toBe("booked");
      expect(await allAudits()).toEqual([]);
    });

    it("refused while the booking is flagged for rescheduling", async () => {
      const id = await insert(at(TODAY, "09:00"), { needsReschedule: true, rescheduleReason: "maintenance" });
      actAs("operator");
      expect(await confirmIdentity({ bookingId: id })).toEqual({ ok: false, error: "refused" });
      expect((await row(id)).status).toBe("booked");
    });

    it("parallel confirmations of one booking: exactly one wins", async () => {
      const id = await insert(at(TODAY, "09:00"));
      actAs("operator");
      const results = await Promise.all(Array.from({ length: 6 }, () => confirmIdentity({ bookingId: id })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual(Array(5).fill({ ok: false, error: "refused" }));
      expect(await allAudits()).toHaveLength(1);
    });
  });

  describe("T3 markReady", () => {
    it("records the waste and who, clears a flag, and notifies each active user of the college", async () => {
      const id = await insert(
        at(TODAY, "09:00"),
        { needsReschedule: true, rescheduleReason: "maintenance" },
        "in_progress",
      );
      actAs("operator");
      expect(await markReady({ bookingId: id, wastedSheets: 12, wasteDestroyed: true })).toMatchObject({
        ok: true,
        booking: { status: "ready" },
      });
      expect(await row(id)).toMatchObject({
        status: "ready",
        wastedSheets: 12,
        wasteDestroyed: true,
        readyBy: ids.operator,
        readyAt: NOW,
        needsReschedule: false,
        rescheduleReason: null,
      });
      const rows = await allNotifications();
      expect(rows.map((n) => [n.userId, n.type, n.bookingId, n.readAt])).toEqual([
        [ids.collegeA, "booking_ready", id, null],
      ]);
      expect(rows[0].data).toEqual({
        reference: "2026-0001",
        startsAt: at(TODAY, "09:00").toISOString(),
        endsAt: at(TODAY, "09:10").toISOString(),
      });
      expect(await allAudits()).toEqual([]); // T3 is not in the audited list (§6)
    });

    it("zero waste is a valid answer; the destroyed tick and a whole, non-negative count are required", async () => {
      const id = await insert(at(TODAY, "09:00"), {}, "in_progress");
      actAs("operator");
      for (const bad of [
        { bookingId: id, wastedSheets: 0 },
        { bookingId: id, wastedSheets: 0, wasteDestroyed: false },
        { bookingId: id, wastedSheets: -1, wasteDestroyed: true },
        { bookingId: id, wastedSheets: 1.5, wasteDestroyed: true },
        { bookingId: id, wastedSheets: "3", wasteDestroyed: true },
        { bookingId: id, wastedSheets: 2_147_483_648, wasteDestroyed: true },
        { bookingId: id, wasteDestroyed: true },
      ]) {
        expect(await markReady(bad)).toEqual({ ok: false, error: "validation" });
      }
      expect((await row(id)).status).toBe("in_progress");
      expect(await markReady({ bookingId: id, wastedSheets: 0, wasteDestroyed: true })).toMatchObject({ ok: true });
      expect((await row(id)).wastedSheets).toBe(0);
    });
  });

  describe("T4 markDelivered", () => {
    it("records who and when; no notification, no audit", async () => {
      const id = await insert(at(TODAY, "09:00"), {}, "ready");
      actAs("operator");
      expect(await markDelivered({ bookingId: id })).toMatchObject({ ok: true, booking: { status: "delivered" } });
      expect(await row(id)).toMatchObject({ deliveredBy: ids.operator, deliveredAt: NOW });
      expect(await allNotifications()).toEqual([]);
      expect(await allAudits()).toEqual([]);
    });
  });

  describe("T7 markNoShow", () => {
    it("refused before the start, allowed from the start on", async () => {
      const later = await insert(at(TODAY, "10:10"));
      const started = await insert(at(TODAY, "10:00"));
      actAs("operator");
      expect(await markNoShow({ bookingId: later })).toEqual({ ok: false, error: "refused" });
      expect(await markNoShow({ bookingId: started })).toMatchObject({ ok: true, booking: { status: "no_show" } });

      vi.setSystemTime(at(TODAY, "10:10")); // exactly the start
      expect(await markNoShow({ bookingId: later })).toMatchObject({ ok: true });
    });

    it("records who and when, clears a flag, audits, notifies, and releases the interval", async () => {
      const id = await insert(at(TODAY, "09:00"), { needsReschedule: true, rescheduleReason: "delay_no_slot" });
      actAs("admin");
      expect(await markNoShow({ bookingId: id })).toMatchObject({ ok: true });
      expect(await row(id)).toMatchObject({
        status: "no_show",
        noShowBy: ids.admin,
        noShowAt: NOW,
        needsReschedule: false,
        rescheduleReason: null,
      });
      expect((await allAudits()).map((a) => [a.action, a.entityId, a.collegeId])).toEqual([
        ["booking.no_show", String(id), collegeIds.A],
      ]);
      expect((await allNotifications()).map((n) => [n.userId, n.type])).toEqual([
        [ids.collegeA, "booking_no_show"],
      ]);
      // The same machine and interval can be booked again.
      await expect(insert(at(TODAY, "09:00"))).resolves.toBeGreaterThan(id);
    });
  });

  describe("getBooking", () => {
    it("a college reads its own booking without the machine; another college's is not found", async () => {
      const own = await insert(at(TODAY, "09:00"));
      const other = await insert(at(TODAY, "09:30"), { collegeId: collegeIds.B, createdBy: ids.collegeB });
      actAs("collegeA");
      expect(await getBooking({ bookingId: own })).toMatchObject({
        ok: true,
        booking: { id: own, reference: "2026-0001", collegeName: "كلية أ", impressions: 200, sheets: 200, machineName: null },
      });
      expect(await getBooking({ bookingId: other })).toEqual({ ok: false, error: "not_found" });
      expect(await getBooking({ bookingId: 999_999 })).toEqual({ ok: false, error: "not_found" });
      expect(await getBooking({ bookingId: own, collegeId: collegeIds.A })).toEqual({ ok: false, error: "validation" });
    });

    it("an operator and an admin read any booking, with the machine", async () => {
      const id = await insert(at(TODAY, "09:00"), { collegeId: collegeIds.B, createdBy: ids.collegeB });
      for (const name of ["operator", "admin"] as const) {
        actAs(name);
        expect(await getBooking({ bookingId: id })).toMatchObject({
          ok: true,
          booking: { id, collegeId: collegeIds.B, machineName: "M1", status: "booked" },
        });
      }
    });
  });

  describe("getWhatsAppLink", () => {
    it("'started' only while in_progress, 'ready' only while ready; the text of contracts §3.10", async () => {
      const id = await insert(at(TODAY, "09:00"), { subject: "رياضيات ١" });
      actAs("operator");
      expect(await getWhatsAppLink({ bookingId: id, kind: "started" })).toEqual({ ok: false, error: "refused" });
      expect(await getWhatsAppLink({ bookingId: id, kind: "ready" })).toEqual({ ok: false, error: "refused" });

      await confirmIdentity({ bookingId: id });
      const started = await getWhatsAppLink({ bookingId: id, kind: "started" });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const url = new URL(started.url);
      expect(url.origin + url.pathname).toBe("https://wa.me/218912345678");
      expect(url.searchParams.get("text")).toBe(
        "مركز التصوير والطباعة – جامعة طرابلس: بدأ تصوير «رياضيات ١» (كلية أ) على الآلة M1. المرجع 2026-0001.",
      );
      expect(await getWhatsAppLink({ bookingId: id, kind: "ready" })).toEqual({ ok: false, error: "refused" });

      await markReady({ bookingId: id, wastedSheets: 0, wasteDestroyed: true });
      const ready = await getWhatsAppLink({ bookingId: id, kind: "ready" });
      expect(ready.ok && new URL(ready.url).searchParams.get("text")).toBe(
        "مركز التصوير والطباعة – جامعة طرابلس: «رياضيات ١» (كلية أ) جاهز للاستلام. المرجع 2026-0001.",
      );
      expect(await getWhatsAppLink({ bookingId: id, kind: "started" })).toEqual({ ok: false, error: "refused" });
      expect(await allAudits()).toHaveLength(1); // only the confirmation: the link writes nothing
    });

    it("unknown booking and bad input", async () => {
      actAs("admin");
      expect(await getWhatsAppLink({ bookingId: 999_999, kind: "ready" })).toEqual({ ok: false, error: "not_found" });
      expect(await getWhatsAppLink({ bookingId: 1, kind: "other" })).toEqual({ ok: false, error: "validation" });
      expect(await getWhatsAppLink({ bookingId: 1 })).toEqual({ ok: false, error: "validation" });
    });
  });

  describe("listMyNotifications and markNotificationRead: own rows only", () => {
    it("each user sees only their rows, newest first, with the unread count; marking read is own-only", async () => {
      const first = await insert(at(TODAY, "09:00"), {}, "in_progress");
      const second = await insert(at(TODAY, "09:30"), {}, "in_progress");
      actAs("operator");
      await markReady({ bookingId: first, wastedSheets: 0, wasteDestroyed: true });
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));
      await markReady({ bookingId: second, wastedSheets: 0, wasteDestroyed: true });

      actAs("collegeA");
      const list = await listMyNotifications();
      expect(list.unread).toBe(2);
      expect(list.items.map((n) => n.bookingId)).toEqual([second, first]);

      actAs("collegeB");
      expect(await listMyNotifications()).toEqual({ ok: true, unread: 0, items: [] });
      // collegeB cannot mark collegeA's row: not found, and it stays unread.
      expect(await markNotificationRead({ id: list.items[0].id })).toEqual({ ok: false, error: "not_found" });

      actAs("collegeA");
      expect(await markNotificationRead({ id: list.items[0].id })).toEqual({ ok: true });
      expect(await markNotificationRead({ id: list.items[0].id })).toEqual({ ok: true }); // again: no-op
      const after = await listMyNotifications();
      expect(after.unread).toBe(1);
      expect(after.items[0].readAt).toEqual(new Date(NOW.getTime() + 60_000));

      for (const bad of [undefined, {}, { id: "1" }, { id: 0 }, { id: 1, x: 1 }]) {
        expect(await markNotificationRead(bad)).toEqual({ ok: false, error: "validation" });
      }
      browser.reset();
      await expect(listMyNotifications()).rejects.toMatchObject({ to: "/login" });
    });
  });
});
