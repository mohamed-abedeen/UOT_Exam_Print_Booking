// Step 1.7 — getDayQueue: who may read it, what it returns, and that it only reads.
// Skipped when DATABASE_URL is not set.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { bookings, colleges, machines, users } from "@/db/schema";
import { getDayQueue } from "@/lib/actions/bookings";
import { AuthError, SESSION_COOKIE } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import { addDays, atMinutes } from "@/lib/scheduling/time";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const SUNDAY = "2026-11-29";
const MONDAY = "2026-11-30";
const at = (date: string, hhmm: string) => atMinutes(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

const NAMES = ["admin", "operator", "collegeA"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 1.7: getDayQueue", () => {
  const tokens = {} as Record<Name, string>;
  const m = {} as { M1: number; M2: number };
  let collegeId = 0;
  let creatorId = 0;
  let seq = 0;

  function actAs(name: Name) {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  }

  async function insert(
    machineId: number,
    startsAt: Date,
    endsAt: Date,
    over: Partial<typeof bookings.$inferInsert> = {},
  ) {
    seq += 1;
    await getDb()
      .insert(bookings)
      .values({
        refYear: 2026,
        refSeq: seq,
        reference: `2026-${String(seq).padStart(4, "0")}`,
        collegeId,
        createdBy: creatorId,
        doctorName: "د. أحمد سالم",
        doctorPhone: "218912345678",
        recipientName: "محمد علي حسن الطرابلسي",
        subject: `مادة ${seq}`,
        serviceType: "exam_questions",
        copies: 100,
        models: 1,
        pagesPerModel: 2,
        sides: "single",
        machineId,
        startsAt,
        endsAt,
        ...over,
      });
  }

  const count = async () =>
    Number(((await getDb().execute(sql`SELECT count(*)::int AS n FROM bookings`))[0] as { n: number }).n);

  beforeEach(async () => {
    await resetTestDb();
    browser.reset();
    seq = 0;
    const db = getDb();

    const [college] = await db.insert(colleges).values({ name: "كلية أ" }).returning({ id: colleges.id });
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
    creatorId = userRows[2].id;
    for (const [i, name] of NAMES.entries()) {
      tokens[name] = (await createSession(db, userRows[i].id, { ip: null, userAgent: null }, new Date())).token;
    }

    const laser = { model: "x", type: "laser" as const, supportsDuplex: true, setupMinutesPerModel: 5, priority: 1 };
    const rows = await db
      .insert(machines)
      .values([
        { ...laser, name: "M1", minSheets: 1, maxSheets: 400, speedPerHour: 3000 },
        { ...laser, name: "M2", minSheets: 401, maxSheets: 800, speedPerHour: 4200 },
      ])
      .returning({ id: machines.id });
    Object.assign(m, { M1: rows[0].id, M2: rows[1].id });
  });

  describe("role guard", () => {
    it("a college is refused; no session goes to /login", async () => {
      actAs("collegeA");
      await expect(getDayQueue(SUNDAY)).rejects.toBeInstanceOf(AuthError);
      browser.reset();
      await expect(getDayQueue(SUNDAY)).rejects.toMatchObject({ to: "/login" });
    });

    it("an operator and an admin may read it", async () => {
      for (const name of ["operator", "admin"] as const) {
        actAs(name);
        await expect(getDayQueue(SUNDAY)).resolves.toMatchObject({ ok: true, date: SUNDAY, rows: [] });
      }
    });
  });

  describe("what it returns", () => {
    it("the day's bookings by start time, then machine, with every status except cancelled", async () => {
      await insert(m.M2, at(SUNDAY, "10:00"), at(SUNDAY, "10:30"), { status: "booked" });
      await insert(m.M1, at(SUNDAY, "10:00"), at(SUNDAY, "10:20"), { status: "booked" });
      await insert(m.M1, at(SUNDAY, "09:00"), at(SUNDAY, "09:20"), {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledBy: creatorId,
      });
      await insert(m.M1, at(SUNDAY, "09:30"), at(SUNDAY, "09:50"), { status: "no_show", noShowAt: new Date() });
      await insert(m.M2, at(SUNDAY, "09:00"), at(SUNDAY, "09:30"), {
        status: "in_progress",
        identityConfirmedAt: new Date(),
        needsReschedule: true,
        rescheduleReason: "maintenance",
      });

      actAs("operator");
      const result = await getDayQueue(SUNDAY);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows.map((r) => [r.machineName, r.status])).toEqual([
        ["M2", "in_progress"],
        ["M1", "no_show"],
        ["M1", "booked"],
        ["M2", "booked"],
      ]);
      const first = result.rows[0];
      expect(first).toMatchObject({
        collegeName: "كلية أ",
        doctorName: "د. أحمد سالم",
        needsReschedule: true,
        copies: 100,
        models: 1,
        pagesPerModel: 2,
        sides: "single",
        serviceType: "exam_questions",
      });
      expect(first.startsAt).toEqual(at(SUNDAY, "09:00"));
      expect(first.endsAt).toEqual(at(SUNDAY, "09:30"));
      expect(first.reference).toMatch(/^2026-\d{4}$/);
    });

    it("a booking belongs to the Tripoli day it starts on, not the UTC day", async () => {
      await insert(m.M1, at(SUNDAY, "00:00"), at(SUNDAY, "00:20")); // 22:00 UTC the day before
      await insert(m.M1, at(SUNDAY, "23:40"), at(SUNDAY, "23:50"));
      await insert(m.M1, at(MONDAY, "00:00"), at(MONDAY, "00:10")); // next day
      await insert(m.M1, at(addDays(SUNDAY, -1), "23:50"), at(SUNDAY, "00:00")); // the day before

      actAs("operator");
      const result = await getDayQueue(SUNDAY);
      expect(result.ok && result.rows.map((r) => r.startsAt)).toEqual([at(SUNDAY, "00:00"), at(SUNDAY, "23:40")]);
      const next = await getDayQueue(MONDAY);
      expect(next.ok && next.rows).toHaveLength(1);
    });
  });

  describe("input and side effects", () => {
    it("a date that is not a real YYYY-MM-DD is a validation error", async () => {
      actAs("operator");
      for (const bad of ["", "today", "2026-2-3", "2026-02-30", "2026-13-01", "2026-11-29; DROP TABLE bookings", null, undefined, 20261129]) {
        await expect(getDayQueue(bad)).resolves.toEqual({ ok: false, error: "validation" });
      }
    });

    it("it writes nothing", async () => {
      await insert(m.M1, at(SUNDAY, "10:00"), at(SUNDAY, "10:20"));
      actAs("operator");
      const before = await count();
      await getDayQueue(SUNDAY);
      expect(await count()).toBe(before);
    });
  });
});
