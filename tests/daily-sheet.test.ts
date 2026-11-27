// Step 4.1 — getDailySheet: the roles that may read it and the rows it returns (the queue's rows). Skipped without DATABASE_URL.
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { bookings, colleges, machines, users } from "@/db/schema";
import { getDailySheet, getDayQueue } from "@/lib/actions/bookings";
import { AuthError, SESSION_COOKIE } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import { atMinutes } from "@/lib/scheduling/time";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const SUNDAY = "2026-11-29";
const NAMES = ["admin", "operator", "collegeA"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 4.1: getDailySheet", () => {
  const tokens = {} as Record<Name, string>;
  let machineId = 0;
  let collegeId = 0;
  let creatorId = 0;

  const actAs = (name: Name) => {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  };

  beforeEach(async () => {
    await resetTestDb();
    browser.reset();
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
    const [machine] = await db
      .insert(machines)
      .values({ name: "M1", model: "x", type: "laser", supportsDuplex: true, setupMinutesPerModel: 5, priority: 1, minSheets: 1, maxSheets: 400, speedPerHour: 3000 })
      .returning({ id: machines.id });
    machineId = machine.id;
  });

  async function insert(seq: number, hour: number, status: "booked" | "cancelled" | "no_show") {
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
        recipientName: "محمد علي",
        subject: `مادة ${seq}`,
        serviceType: "exam_questions",
        copies: 100,
        models: 1,
        pagesPerModel: 2,
        sides: "single",
        machineId,
        startsAt: atMinutes(SUNDAY, hour * 60),
        endsAt: atMinutes(SUNDAY, hour * 60 + 20),
        status,
        ...(status === "no_show" ? { noShowAt: new Date() } : {}),
        ...(status === "cancelled" ? { cancelledAt: new Date(), cancelledBy: creatorId } : {}),
      });
  }

  it("a college and a visitor without a session are refused", async () => {
    actAs("collegeA");
    await expect(getDailySheet(SUNDAY)).rejects.toBeInstanceOf(AuthError);
    browser.reset();
    await expect(getDailySheet(SUNDAY)).rejects.toMatchObject({ to: "/login" });
  });

  it("an operator and an admin get the queue's rows: every status except cancelled, by time", async () => {
    await insert(1, 11, "booked");
    await insert(2, 9, "no_show");
    await insert(3, 10, "cancelled");
    for (const name of ["operator", "admin"] as const) {
      actAs(name);
      const sheet = await getDailySheet(SUNDAY);
      expect(sheet).toMatchObject({ ok: true, date: SUNDAY });
      expect(sheet.ok && sheet.rows.map((r) => r.reference)).toEqual(["2026-0002", "2026-0001"]);
      expect(sheet).toEqual(await getDayQueue(SUNDAY));
    }
  });

  it("a date that is not a real day answers validation", async () => {
    actAs("admin");
    for (const bad of ["2026-02-30", "29-11-2026", "", null, 5]) {
      await expect(getDailySheet(bad)).resolves.toEqual({ ok: false, error: "validation" });
    }
  });
});
