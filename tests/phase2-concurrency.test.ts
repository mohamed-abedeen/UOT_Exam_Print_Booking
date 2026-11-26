// Step 2.8 — review of phase 2: calls that really run at the same time (contracts §3.9). The other test files
// force a rival through a hook; here the scheduling lock, the guarded UPDATEs and `bookings_no_overlap` are left to
// sort out real parallel requests. Skipped when DATABASE_URL is not set.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { bookings, colleges, machineMaintenance, machines, settings, users } from "@/db/schema";
import type { Actor } from "@/lib/auth/guard";
import { moveBookingFor, sendDelayNoticeFor } from "@/lib/bookings/change";
import { createBookingFor } from "@/lib/bookings/create";
import { cancelBookingFor } from "@/lib/bookings/lifecycle";
import { startMaintenanceFor } from "@/lib/maintenance";
import { atMinutes } from "@/lib/scheduling/time";
import { resetTestDb } from "./helpers/test-db";

const SATURDAY = "2026-11-28";
const SUNDAY = "2026-11-29";
const at = (date: string, hhmm: string) => atMinutes(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const NOW = at(SATURDAY, "12:00");

const NAMES = ["admin", "collegeA", "collegeB"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 2.8: phase 2 under real concurrency", () => {
  const ids = {} as Record<Name, number>;
  const collegeIds = {} as { A: number; B: number };
  const m = {} as { M1: number; M2: number; M3: number; M4: number };
  let seq = 0;

  function actor(name: Name): Actor {
    return {
      sessionId: "test",
      userId: ids[name],
      role: name === "admin" ? "admin" : "college",
      collegeId: name === "collegeA" ? collegeIds.A : name === "collegeB" ? collegeIds.B : null,
      username: name,
      fullName: name,
      mustChangePassword: false,
      ip: null,
    } as Actor;
  }

  /** A `booked` row of college A written straight into the table: 1 × 2 × 150 single (300 impressions). */
  async function insert(machineId: number, from: string, to: string, over: Partial<typeof bookings.$inferInsert> = {}) {
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
        startsAt: at(SUNDAY, from),
        endsAt: at(SUNDAY, to),
        ...over,
      })
      .returning({ id: bookings.id });
    return row.id;
  }

  const row = async (id: number) => (await getDb().select().from(bookings).where(eq(bookings.id, id)))[0];
  const holdingRows = async () =>
    (await getDb().select().from(bookings)).filter((b) => b.status !== "cancelled" && b.status !== "no_show");

  /** No two holding bookings share time on a machine. */
  async function expectNoOverlap() {
    const rows = await holdingRows();
    for (const a of rows) {
      for (const b of rows) {
        if (a.id >= b.id || a.machineId !== b.machineId) continue;
        const overlap = a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
        expect(overlap, `${a.reference} and ${b.reference} overlap`).toBe(false);
      }
    }
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    await resetTestDb();
    seq = 0;
    const db = getDb();

    const [a, b] = await db.insert(colleges).values([{ name: "كلية أ" }, { name: "كلية ب" }]).returning();
    Object.assign(collegeIds, { A: a.id, B: b.id });

    const base = { passwordHash: "not-a-real-hash", mustChangePassword: false };
    const userRows = await db
      .insert(users)
      .values([
        { ...base, username: "admin", role: "admin", fullName: "مسؤول" },
        { ...base, username: "collegeA", role: "college", fullName: "منسق أ", collegeId: a.id },
        { ...base, username: "collegeB", role: "college", fullName: "منسق ب", collegeId: b.id },
      ])
      .returning({ id: users.id });
    for (const [i, name] of NAMES.entries()) ids[name] = userRows[i].id;

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

  it("eight delay notices at once: each booking ends later than it was, on its own interval", async () => {
    const starts = ["09:00", "09:20", "09:40", "10:00", "10:20", "10:40", "11:00", "11:20"];
    const idsOfBookings: number[] = [];
    for (const s of starts) {
      const [h, min] = s.split(":").map(Number);
      const end = `${String(h + (min === 40 ? 1 : 0)).padStart(2, "0")}:${String((min + 20) % 60).padStart(2, "0")}`;
      idsOfBookings.push(await insert(m.M1, s, end));
    }

    const results = await Promise.all(idsOfBookings.map((bookingId) => sendDelayNoticeFor(actor("collegeA"), { bookingId })));

    expect(results.map((r) => r.ok)).toEqual(starts.map(() => true));
    const taken = new Set<string>();
    for (const [i, bookingId] of idsOfBookings.entries()) {
      const r = await row(bookingId);
      expect(r.delayNoticeAt).not.toBeNull();
      expect(r.delayedFrom).toEqual(at(SUNDAY, starts[i]));
      if (r.needsReschedule) {
        expect(r.rescheduleReason).toBe("delay_no_slot");
        expect(r.startsAt).toEqual(at(SUNDAY, starts[i]));
      } else {
        expect(r.startsAt.getTime()).toBeGreaterThan(at(SUNDAY, starts[i]).getTime());
        expect(r.endsAt.getTime()).toBeLessThanOrEqual(at(SUNDAY, "15:00").getTime());
      }
      taken.add(`${r.machineId}|${r.startsAt.toISOString()}`);
    }
    expect(taken.size).toBe(starts.length);
    await expectNoOverlap();
  });

  it("two admin moves to the same target at once: one lands, the other answers busy and stays", async () => {
    const one = await insert(m.M1, "09:00", "09:20");
    const two = await insert(m.M1, "09:20", "09:40");
    const target = { machineId: m.M1, startsAt: at(SUNDAY, "13:00") };

    const results = await Promise.all([one, two].map((bookingId) => moveBookingFor(actor("admin"), { bookingId, ...target })));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.find((r) => !r.ok);
    expect(lost).toEqual({ ok: false, error: "slot_taken", reason: "busy" });
    const loserId = results[0].ok ? two : one;
    const loser = await row(loserId);
    expect(loser.startsAt).toEqual(at(SUNDAY, loserId === one ? "09:00" : "09:20"));
    await expectNoOverlap();
  });

  it("a stop recorded while colleges book that machine: nothing unflagged is left inside the window", async () => {
    const form = {
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
    };
    const window = { startsAt: at(SUNDAY, "10:00"), endsAt: at(SUNDAY, "12:00") };

    const [stop, ...created] = await Promise.all([
      startMaintenanceFor(actor("admin"), { machineId: m.M1, ...window, reason: "صيانة" }),
      ...Array.from({ length: 12 }, (_, i) => createBookingFor(actor(i % 2 ? "collegeA" : "collegeB"), form)),
    ]);

    expect(stop.ok).toBe(true);
    expect(created.some((r) => r.ok)).toBe(true);
    expect(await getDb().select().from(machineMaintenance)).toHaveLength(1);
    const inside = (await holdingRows()).filter(
      (b) =>
        b.machineId === m.M1 &&
        b.startsAt.getTime() < window.endsAt.getTime() &&
        b.endsAt.getTime() > window.startsAt.getTime(),
    );
    expect(inside.filter((b) => !b.needsReschedule)).toEqual([]);
    for (const b of inside) expect(b.rescheduleReason).toBe("maintenance");
    await expectNoOverlap();
  });

  it("a cancel and a delay notice on the same booking at once: it ends cancelled, with no flag", async () => {
    for (let round = 0; round < 5; round++) {
      const bookingId = await insert(m.M1, "09:00", "09:20", { machineId: m.M1 });
      // Everything later that day is busy, so the notice would flag the booking, not move it.
      const blockers: number[] = [];
      for (const machineId of [m.M1, m.M2, m.M3, m.M4]) {
        blockers.push(
          await insert(machineId, machineId === m.M1 ? "09:20" : "09:00", "15:00", {
            collegeId: collegeIds.B,
            createdBy: ids.collegeB,
          }),
        );
      }

      const [cancel, delay] = await Promise.all([
        cancelBookingFor(actor("collegeA"), { bookingId }),
        sendDelayNoticeFor(actor("collegeA"), { bookingId }),
      ]);

      expect(cancel.ok).toBe(true);
      if (!delay.ok) expect(delay.error).toBe("refused");
      const r = await row(bookingId);
      expect(r.status).toBe("cancelled");
      expect({ needsReschedule: r.needsReschedule, rescheduleReason: r.rescheduleReason }).toEqual({
        needsReschedule: false,
        rescheduleReason: null,
      });
      for (const id of [bookingId, ...blockers]) await getDb().delete(bookings).where(eq(bookings.id, id));
    }
  });
});
