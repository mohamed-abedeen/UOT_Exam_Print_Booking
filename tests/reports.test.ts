// Step 4.2 — the four reports (contracts §4, §8.38): who may read them, what each counts, the edges of a range, and the
// downtime arithmetic. The downtime part is pure; the rest needs DATABASE_URL and is skipped without it.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { bookings, colleges, inventoryItems, inventoryMovements, machineMaintenance, machines, users } from "@/db/schema";
import { reportByCollege, reportByMachine, reportPeakHours, reportWasteAndStock } from "@/lib/actions/reports";
import { AuthError, SESSION_COOKIE, type Actor } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import { reportByMachineFor } from "@/lib/reports";
import { downtimeMinutes } from "@/lib/reports/downtime";
import { defaultRange, percentText } from "@/lib/reports/form";
import { atMinutes } from "@/lib/scheduling/time";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const at = (date: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return atMinutes(date, h * 60 + m);
};

describe("downtimeMinutes", () => {
  const from = at("2026-11-29", "00:00");
  const to = at("2026-12-01", "00:00");
  const now = at("2026-11-30", "10:00");

  it("clips a window to the range and adds the windows of one machine", () => {
    expect(downtimeMinutes([{ startsAt: at("2026-11-29", "08:00"), endsAt: at("2026-11-29", "09:30") }], from, to, now)).toBe(90);
    expect(downtimeMinutes([{ startsAt: at("2026-11-28", "22:00"), endsAt: at("2026-11-29", "01:00") }], from, to, now)).toBe(60);
    expect(downtimeMinutes([{ startsAt: at("2026-11-30", "23:00"), endsAt: at("2026-12-01", "05:00") }], from, to, now)).toBe(60);
    const two = [
      { startsAt: at("2026-11-29", "08:00"), endsAt: at("2026-11-29", "09:00") },
      { startsAt: at("2026-11-29", "10:00"), endsAt: at("2026-11-29", "10:30") },
    ];
    expect(downtimeMinutes(two, from, to, now)).toBe(90);
  });

  it("an open window runs to now, or to the end of the range when now is past it; one not started yet adds nothing", () => {
    expect(downtimeMinutes([{ startsAt: at("2026-11-30", "08:00"), endsAt: null }], from, to, now)).toBe(120);
    expect(downtimeMinutes([{ startsAt: at("2026-11-30", "08:00"), endsAt: null }], from, to, at("2026-12-09", "00:00"))).toBe(960);
    expect(downtimeMinutes([{ startsAt: at("2026-11-30", "12:00"), endsAt: null }], from, to, now)).toBe(0);
  });

  it("a planned window inside the range counts in full; a cancelled one (ends where it starts), or none, is 0", () => {
    expect(downtimeMinutes([{ startsAt: at("2026-11-30", "14:00"), endsAt: at("2026-11-30", "16:00") }], from, to, now)).toBe(120);
    expect(downtimeMinutes([{ startsAt: at("2026-11-30", "14:00"), endsAt: at("2026-11-30", "14:00") }], from, to, now)).toBe(0);
    expect(downtimeMinutes([], from, to, now)).toBe(0);
  });
});

describe("report form helpers", () => {
  it("the default range is the first of the month up to today", () => {
    expect(defaultRange("2026-11-27")).toEqual({ from: "2026-11-01", to: "2026-11-27" });
    expect(defaultRange("2026-12-01")).toEqual({ from: "2026-12-01", to: "2026-12-01" });
  });

  it("percentText keeps one decimal and has no value for an empty whole", () => {
    expect(percentText(25, 200)).toBe("12.5");
    expect(percentText(7, 100)).toBe("7");
    expect(percentText(1, 3)).toBe("33.3");
    expect(percentText(5, 0)).toBeNull();
  });
});

const SUN = "2026-11-29";
const MON = "2026-11-30";
const NAMES = ["admin", "operator", "collegeA"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 4.2: the report actions", () => {
  const tokens = {} as Record<Name, string>;
  let adminId = 0;
  let collegeA = 0;
  let collegeB = 0;
  let m1 = 0;
  let m2 = 0;
  let seq = 0;

  const actAs = (name: Name) => {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  };

  beforeEach(async () => {
    await resetTestDb();
    browser.reset();
    seq = 0;
    const db = getDb();
    const [a, b] = await db.insert(colleges).values([{ name: "كلية أ" }, { name: "كلية ب" }]).returning({ id: colleges.id });
    collegeA = a.id;
    collegeB = b.id;
    const base = { passwordHash: "not-a-real-hash", mustChangePassword: false };
    const userRows = await db
      .insert(users)
      .values([
        { ...base, username: "admin", role: "admin", fullName: "مسؤول" },
        { ...base, username: "operator", role: "operator", fullName: "فني" },
        { ...base, username: "collegeA", role: "college", fullName: "منسق أ", collegeId: collegeA },
      ])
      .returning({ id: users.id });
    adminId = userRows[0].id;
    for (const [i, name] of NAMES.entries()) {
      tokens[name] = (await createSession(db, userRows[i].id, { ip: null, userAgent: null }, new Date())).token;
    }
    const machine = (name: string, priority: number) => ({
      name,
      model: "x",
      type: "laser" as const,
      supportsDuplex: true,
      setupMinutesPerModel: 5,
      priority,
      minSheets: 1,
      maxSheets: null,
      speedPerHour: 3000,
    });
    const rows = await db.insert(machines).values([machine("M1", 1), machine("M2", 2)]).returning({ id: machines.id });
    m1 = rows[0].id;
    m2 = rows[1].id;
  });

  type Status = "booked" | "in_progress" | "ready" | "delivered" | "cancelled" | "no_show";
  async function book(opts: {
    college: number;
    machine: number;
    date: string;
    time: string;
    minutes?: number;
    status?: Status;
    models?: number;
    pages?: number;
    copies?: number;
    sides?: "single" | "duplex";
    wasted?: number;
    readyAt?: Date;
    delayNoticeAt?: Date;
  }) {
    const status = opts.status ?? "booked";
    seq += 1;
    const starts = at(opts.date, opts.time);
    const finished = status === "ready" || status === "delivered";
    await getDb()
      .insert(bookings)
      .values({
        refYear: 2026,
        refSeq: seq,
        reference: `2026-${String(seq).padStart(4, "0")}`,
        collegeId: opts.college,
        createdBy: adminId,
        doctorName: "د. أحمد سالم",
        doctorPhone: "218912345678",
        recipientName: "محمد علي",
        subject: `مادة ${seq}`,
        serviceType: "exam_questions",
        copies: opts.copies ?? 100,
        models: opts.models ?? 1,
        pagesPerModel: opts.pages ?? 2,
        sides: opts.sides ?? "single",
        machineId: opts.machine,
        startsAt: starts,
        endsAt: new Date(starts.getTime() + (opts.minutes ?? 20) * 60_000),
        status,
        delayNoticeAt: opts.delayNoticeAt ?? null,
        ...(status === "no_show" ? { noShowAt: new Date() } : {}),
        ...(status === "cancelled" ? { cancelledAt: new Date(), cancelledBy: adminId } : {}),
        ...(status === "in_progress" || finished ? { identityConfirmedAt: new Date() } : {}),
        ...(finished ? { wastedSheets: opts.wasted ?? 0, wasteDestroyed: true, readyAt: opts.readyAt ?? starts } : {}),
        ...(status === "delivered" ? { deliveredAt: new Date() } : {}),
      });
  }

  it("only an admin may read a report; a college, an operator and a visitor are refused", async () => {
    for (const name of ["collegeA", "operator"] as const) {
      actAs(name);
      for (const call of [reportByCollege, reportByMachine, reportWasteAndStock, reportPeakHours]) {
        await expect(call(SUN, SUN)).rejects.toBeInstanceOf(AuthError);
      }
    }
    browser.reset();
    await expect(reportByCollege(SUN, SUN)).rejects.toMatchObject({ to: "/login" });
  });

  it("a range that is not two real dates in order answers validation", async () => {
    actAs("admin");
    const bad: [unknown, unknown][] = [
      ["2026-02-30", SUN],
      [SUN, "29-11-2026"],
      [MON, SUN],
      ["", ""],
      [null, SUN],
      [5, 6],
    ];
    for (const [from, to] of bad) {
      for (const call of [reportByCollege, reportByMachine, reportWasteAndStock, reportPeakHours]) {
        await expect(call(from, to)).resolves.toEqual({ ok: false, error: "validation" });
      }
    }
  });

  it("an empty range gives empty rows and zero totals, no error", async () => {
    actAs("admin");
    await expect(reportByCollege(SUN, SUN)).resolves.toEqual({
      ok: true,
      rows: [],
      totals: { bookings: 0, impressions: 0, sheets: 0, cancelled: 0, noShows: 0, delayNotices: 0 },
    });
    await expect(reportPeakHours(SUN, SUN)).resolves.toEqual({ ok: true, rows: [] });
    await expect(reportWasteAndStock(SUN, SUN)).resolves.toEqual({
      ok: true,
      waste: { bookings: 0, sheets: 0, wastedSheets: 0 },
      items: [],
    });
  });

  it("by college: holding bookings add impressions and sheets; cancelled, no-show and delay notices are own columns", async () => {
    // A: 200 imp / 200 sheets (booked), 200 imp / 100 sheets (duplex, delivered), one cancelled, one no-show.
    await book({ college: collegeA, machine: m1, date: SUN, time: "09:00" });
    await book({ college: collegeA, machine: m1, date: SUN, time: "09:30", status: "delivered", models: 1, pages: 4, copies: 50, sides: "duplex", wasted: 7 });
    await book({ college: collegeA, machine: m1, date: SUN, time: "10:00", status: "cancelled" });
    await book({ college: collegeA, machine: m1, date: SUN, time: "10:30", status: "no_show" });
    // B on Monday: 30 imp, a delay notice sent on Sunday. Outside any range below: A on Friday.
    await book({ college: collegeB, machine: m2, date: MON, time: "09:00", pages: 1, copies: 30, delayNoticeAt: at(SUN, "11:00") });
    await book({ college: collegeA, machine: m1, date: "2026-11-27", time: "09:00" });

    actAs("admin");
    const both = await reportByCollege(SUN, MON);
    expect(both).toEqual({
      ok: true,
      rows: [
        { collegeId: collegeA, collegeName: "كلية أ", bookings: 2, impressions: 400, sheets: 300, cancelled: 1, noShows: 1, delayNotices: 0 },
        { collegeId: collegeB, collegeName: "كلية ب", bookings: 1, impressions: 30, sheets: 30, cancelled: 0, noShows: 0, delayNotices: 1 },
      ],
      totals: { bookings: 3, impressions: 430, sheets: 330, cancelled: 1, noShows: 1, delayNotices: 1 },
    });

    // Sunday alone: B has no booking that day, yet its delay notice was sent on Sunday, so its row is there.
    const sunday = await reportByCollege(SUN, SUN);
    expect(sunday.ok && sunday.rows.map((r) => [r.collegeName, r.bookings, r.delayNotices])).toEqual([
      ["كلية أ", 2, 0],
      ["كلية ب", 0, 1],
    ]);

    // Both ends of the range are inclusive: 09:00 on the first day and 09:00 on the last.
    const friday = await reportByCollege("2026-11-27", "2026-11-27");
    expect(friday.ok && friday.totals.bookings).toBe(1);
    const monday = await reportByCollege(MON, MON);
    expect(monday.ok && monday.totals.bookings).toBe(1);
  });

  it("by machine: bookings, impressions and booked minutes of holding bookings, plus downtime from maintenance", async () => {
    await book({ college: collegeA, machine: m1, date: SUN, time: "09:00", minutes: 30 }); // 200 imp
    await book({ college: collegeA, machine: m1, date: SUN, time: "10:00", minutes: 20, status: "cancelled" });
    await book({ college: collegeA, machine: m1, date: SUN, time: "11:00", minutes: 20, status: "no_show" });
    await book({ college: collegeB, machine: m2, date: SUN, time: "09:00", minutes: 40 });
    await getDb()
      .insert(machineMaintenance)
      .values([
        { machineId: m1, reason: "صيانة", createdBy: adminId, startsAt: at(SUN, "13:00"), endsAt: at(SUN, "14:30") },
        // started the day before the range: only its part inside counts
        { machineId: m2, reason: "عطل", createdBy: adminId, startsAt: at("2026-11-28", "23:00"), endsAt: at(SUN, "01:00") },
      ]);

    actAs("admin");
    const result = await reportByMachine(SUN, SUN);
    expect(result).toEqual({
      ok: true,
      rows: [
        { machineId: m1, machineName: "M1", archived: false, bookings: 1, impressions: 200, bookedMinutes: 30, downtimeMinutes: 90 },
        { machineId: m2, machineName: "M2", archived: false, bookings: 1, impressions: 200, bookedMinutes: 40, downtimeMinutes: 60 },
      ],
      totals: { bookings: 2, impressions: 400, bookedMinutes: 70, downtimeMinutes: 150 },
    });
  });

  it("by machine: an open window runs to now; an archived machine appears only when it has something in the range", async () => {
    await getDb().insert(machineMaintenance).values({ machineId: m1, reason: "عطل", createdBy: adminId, startsAt: at(SUN, "08:00"), endsAt: null });
    await getDb().update(machines).set({ archivedAt: new Date() }).where(eq(machines.id, m2));
    const admin: Actor = {
      sessionId: "s", userId: adminId, role: "admin", collegeId: null, username: "admin", fullName: "مسؤول", mustChangePassword: false, ip: null,
    };
    const result = await reportByMachineFor(admin, SUN, SUN, at(SUN, "10:15"));
    expect(result.ok && result.rows.map((r) => [r.machineName, r.downtimeMinutes, r.archived])).toEqual([["M1", 135, false]]);

    await book({ college: collegeA, machine: m2, date: SUN, time: "09:00" });
    const withBooking = await reportByMachineFor(admin, SUN, SUN, at(SUN, "10:15"));
    expect(withBooking.ok && withBooking.rows.map((r) => [r.machineName, r.bookings, r.archived])).toEqual([
      ["M1", 0, false],
      ["M2", 1, true],
    ]);
  });

  it("waste and stock: wasted sheets by the date work was finished, movements by item and type in the range", async () => {
    await book({ college: collegeA, machine: m1, date: SUN, time: "09:00", status: "ready", wasted: 5, readyAt: at(SUN, "09:30") }); // 200 sheets
    await book({ college: collegeA, machine: m1, date: SUN, time: "10:00", status: "delivered", wasted: 15, readyAt: at(MON, "00:30") }); // finished on Monday
    await book({ college: collegeA, machine: m1, date: SUN, time: "11:00" }); // not finished: no waste yet
    const db = getDb();
    const [paper, toner] = await db
      .insert(inventoryItems)
      .values([
        { name: "ورق", kind: "toner", unit: "ورقة" },
        { name: "حبر", kind: "toner", unit: "علبة" },
      ])
      .returning({ id: inventoryItems.id });
    const move = (itemId: number, type: "receive" | "consume" | "waste" | "adjust", quantity: number, when: Date) =>
      db.insert(inventoryMovements).values({ itemId, type, quantity, createdBy: adminId, createdAt: when, ...(type === "adjust" ? { note: "جرد" } : {}) });
    await move(paper.id, "receive", 1000, at(SUN, "08:00"));
    await move(paper.id, "consume", -200, at(SUN, "09:30"));
    await move(paper.id, "waste", -5, at(SUN, "09:30"));
    await move(paper.id, "adjust", -3, at(SUN, "15:00"));
    await move(paper.id, "consume", -300, at(MON, "09:00")); // Monday only
    await move(toner.id, "receive", 4, at(SUN, "08:00"));

    actAs("admin");
    const sunday = await reportWasteAndStock(SUN, SUN);
    expect(sunday).toEqual({
      ok: true,
      waste: { bookings: 1, sheets: 200, wastedSheets: 5 },
      items: [
        { itemId: toner.id, itemName: "حبر", unit: "علبة", receive: 4, consume: 0, waste: 0, adjust: 0, net: 4 },
        { itemId: paper.id, itemName: "ورق", unit: "ورقة", receive: 1000, consume: -200, waste: -5, adjust: -3, net: 792 },
      ],
    });
    const both = await reportWasteAndStock(SUN, MON);
    expect(both.ok && both.waste).toEqual({ bookings: 2, sheets: 400, wastedSheets: 20 });
    expect(both.ok && both.items.find((i) => i.itemId === paper.id)).toMatchObject({ consume: -500, net: 492 });
  });

  it("peak hours: holding bookings by the business hour of their start, quiet hours left out", async () => {
    // 22:30 UTC on Saturday is 00:30 on Sunday in Tripoli: it belongs to Sunday's hour 0.
    await book({ college: collegeA, machine: m1, date: SUN, time: "09:00" }); // 200
    await book({ college: collegeA, machine: m1, date: SUN, time: "09:30" }); // 200
    await book({ college: collegeB, machine: m2, date: SUN, time: "09:00", pages: 1, copies: 50 }); // 50
    await book({ college: collegeA, machine: m1, date: SUN, time: "14:00" }); // 200
    await book({ college: collegeA, machine: m1, date: SUN, time: "10:00", status: "cancelled" });
    await book({ college: collegeA, machine: m1, date: SUN, time: "10:30", status: "no_show" });
    await book({ college: collegeA, machine: m1, date: SUN, time: "00:30" });

    actAs("admin");
    expect(await reportPeakHours(SUN, SUN)).toEqual({
      ok: true,
      rows: [
        { hour: 0, bookings: 1, impressions: 200 },
        { hour: 9, bookings: 3, impressions: 450 },
        { hour: 14, bookings: 1, impressions: 200 },
      ],
    });
  });
});
