// Step 3.1 — stock (contracts §1.6, §1.9, §1.10, T3, §3.10 getStockAlerts, §4 "Stock"): items, movements, parts,
// the paper and part counters of markReady, alerts. "Done when": every balance equals the sum of its movements —
// `expectBalancesAgree()` runs after every test. Skipped when DATABASE_URL is not set.
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  bookings,
  colleges,
  inventoryItems,
  inventoryMovements,
  machineParts,
  machines,
  settings,
  users,
} from "@/db/schema";
import { markReady } from "@/lib/actions/bookings";
import {
  addMachinePart,
  adjustStock,
  consumeStock,
  createInventoryItem,
  getStockAlerts,
  listInventory,
  listMachineParts,
  listMovements,
  receiveStock,
  replaceMachinePart,
  updateInventoryItem,
} from "@/lib/actions/stock";
import { AuthError, SESSION_COOKIE } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import { addDays, atMinutes } from "@/lib/scheduling/time";
import type { BookingStatus } from "@/lib/scheduling/types";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const TODAY = "2026-11-29"; // a Sunday
const NOW = atMinutes(TODAY, 10 * 60 + 5); // 10:05 Tripoli

const NAMES = ["admin", "operator", "college"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 3.1: stock", () => {
  const tokens = {} as Record<Name, string>;
  const ids = {} as Record<Name, number>;
  const m = {} as { M1: number; M2: number; OLD: number };
  let collegeId = 0;
  let paperId = 0;
  let seq = 0;

  function actAs(name: Name) {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  }

  /** copies × models × pages: 100 × 1 × 2 single-sided = 200 sheets, 200 impressions by default. */
  async function insertBooking(
    status: BookingStatus,
    over: Partial<typeof bookings.$inferInsert> = {},
    date = TODAY,
  ): Promise<number> {
    seq += 1;
    const startsAt = atMinutes(date, 9 * 60 + seq * 10);
    const t = new Date(NOW.getTime() - 60_000);
    const confirmed = { identityConfirmedAt: t, identityConfirmedBy: ids.operator };
    const byStatus: Partial<typeof bookings.$inferInsert> =
      status === "in_progress"
        ? confirmed
        : status === "ready"
          ? { ...confirmed, readyAt: t, readyBy: ids.operator, wastedSheets: 0, wasteDestroyed: true }
          : status === "cancelled"
            ? { cancelledAt: t, cancelledBy: ids.admin }
            : {};
    const [row] = await getDb()
      .insert(bookings)
      .values({
        refYear: 2026,
        refSeq: seq,
        reference: `2026-${String(seq).padStart(4, "0")}`,
        collegeId,
        createdBy: ids.college,
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
        status,
        ...byStatus,
        ...over,
      })
      .returning({ id: bookings.id });
    return row.id;
  }

  const movements = (itemId: number) =>
    getDb().select().from(inventoryMovements).where(eq(inventoryMovements.itemId, itemId)).orderBy(inventoryMovements.id);
  const audits = () => getDb().select().from(auditLog).orderBy(auditLog.id);
  const parts = async (input: unknown) => {
    const r = await listMachineParts(input);
    if (!r.ok) throw new Error("listMachineParts refused");
    return r.items;
  };
  const part = async (id: number) => (await getDb().select().from(machineParts).where(eq(machineParts.id, id)))[0];

  async function newItem(over: Partial<typeof inventoryItems.$inferInsert> = {}): Promise<number> {
    const [row] = await getDb()
      .insert(inventoryItems)
      .values({ name: `صنف ${++seq}`, kind: "toner", unit: "علبة", ...over })
      .returning({ id: inventoryItems.id });
    return row.id;
  }

  async function newPart(machineId: number, over: Partial<typeof machineParts.$inferInsert> = {}): Promise<number> {
    const [row] = await getDb()
      .insert(machineParts)
      .values({ machineId, name: "درم", lifeImpressions: 1000, ...over })
      .returning({ id: machineParts.id });
    return row.id;
  }

  /** The "Done when": the balance of every item (as listInventory shows it) = the raw sum of its movements. */
  async function expectBalancesAgree() {
    actAs("admin");
    const shown = await listInventory();
    const raw = await getDb()
      .select({
        id: inventoryItems.id,
        sum: sql<number>`coalesce((SELECT sum(mv.quantity) FROM inventory_movements mv WHERE mv.item_id = "inventory_items"."id"), 0)`.mapWith(
          Number,
        ),
      })
      .from(inventoryItems);
    expect(new Map(shown.items.map((i) => [i.id, i.balance]))).toEqual(new Map(raw.map((r) => [r.id, r.sum])));
  }

  const balance = async (itemId: number) => {
    actAs("admin");
    return (await listInventory()).items.find((i) => i.id === itemId)!.balance;
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    await resetTestDb();
    browser.reset();
    seq = 0;
    const db = getDb();

    const [c] = await db.insert(colleges).values({ name: "كلية أ" }).returning();
    collegeId = c.id;
    const base = { passwordHash: "not-a-real-hash", mustChangePassword: false };
    const userRows = await db
      .insert(users)
      .values([
        { ...base, username: "admin", role: "admin", fullName: "مسؤول" },
        { ...base, username: "operator", role: "operator", fullName: "فني" },
        { ...base, username: "college", role: "college", fullName: "منسق", collegeId: c.id },
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
        { ...laser, name: "OLD", minSheets: 1, speedPerHour: 3000, archivedAt: new Date(NOW.getTime() - 86_400_000) },
      ])
      .returning({ id: machines.id });
    Object.assign(m, { M1: machineRows[0].id, M2: machineRows[1].id, OLD: machineRows[2].id });

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
    // What drizzle/0004 seeds (the reset empties every table).
    const [paper] = await db
      .insert(inventoryItems)
      .values({ name: "ورق A4", kind: "paper", unit: "ورقة" })
      .returning({ id: inventoryItems.id });
    paperId = paper.id;
  });

  afterEach(async () => {
    await expectBalancesAgree();
    vi.useRealTimers();
  });

  // ---- roles

  it("refuses operators and colleges on every stock action, before reading anything", async () => {
    const calls = [
      () => listInventory(),
      () => listMovements(),
      () => getStockAlerts(),
      () => createInventoryItem({ name: "x", kind: "toner", unit: "علبة" }),
      () => updateInventoryItem({ itemId: paperId, minQuantity: 5 }),
      () => receiveStock({ itemId: paperId, quantity: 5 }),
      () => consumeStock({ itemId: paperId, quantity: 5 }),
      () => adjustStock({ itemId: paperId, quantity: 5, note: "جرد" }),
      () => listMachineParts(),
      () => addMachinePart({ machineId: m.M1, name: "درم", lifeImpressions: 10 }),
      () => replaceMachinePart({ partId: 1 }),
    ];
    for (const who of ["operator", "college"] as const) {
      actAs(who);
      for (const call of calls) await expect(call()).rejects.toThrow(AuthError);
    }
    expect(await movements(paperId)).toEqual([]);
  });

  // ---- receive, consume, adjust

  it("receive +, consume −, adjust ± with a note; each audited; balance is the sum", async () => {
    actAs("admin");
    const r = await receiveStock({ itemId: paperId, quantity: 5000, note: "فاتورة 12" });
    expect(r).toEqual({ ok: true, movementId: expect.any(Number), balance: 5000 });
    expect(await consumeStock({ itemId: paperId, quantity: 300 })).toMatchObject({ ok: true, balance: 4700 });
    expect(await adjustStock({ itemId: paperId, quantity: -50, note: "جرد" })).toMatchObject({ ok: true, balance: 4650 });
    expect(await adjustStock({ itemId: paperId, quantity: 20, note: "عُدّ مرة أخرى" })).toMatchObject({ ok: true, balance: 4670 });

    expect((await movements(paperId)).map((x) => [x.type, x.quantity, x.note, x.createdBy])).toEqual([
      ["receive", 5000, "فاتورة 12", ids.admin],
      ["consume", -300, null, ids.admin],
      ["adjust", -50, "جرد", ids.admin],
      ["adjust", 20, "عُدّ مرة أخرى", ids.admin],
    ]);
    expect((await audits()).map((a) => [a.action, a.entity, a.details])).toEqual([
      ["stock.receive", "inventory_movements", { itemId: paperId, quantity: 5000, note: "فاتورة 12" }],
      ["stock.consume", "inventory_movements", { itemId: paperId, quantity: -300 }],
      ["stock.adjust", "inventory_movements", { itemId: paperId, quantity: -50, note: "جرد" }],
      ["stock.adjust", "inventory_movements", { itemId: paperId, quantity: 20, note: "عُدّ مرة أخرى" }],
    ]);
    expect(await balance(paperId)).toBe(4670);
  });

  it("lets a balance go negative", async () => {
    actAs("admin");
    const toner = await newItem();
    expect(await consumeStock({ itemId: toner, quantity: 2 })).toMatchObject({ ok: true, balance: -2 });
    expect(await balance(toner)).toBe(-2);
  });

  it("refuses bad movements and writes nothing", async () => {
    actAs("admin");
    const bad = [
      () => receiveStock({ itemId: paperId, quantity: 0 }),
      () => receiveStock({ itemId: paperId, quantity: -5 }),
      () => receiveStock({ itemId: paperId, quantity: 1.5 }),
      () => receiveStock({ itemId: paperId, quantity: 1_000_001 }),
      () => receiveStock({ itemId: paperId, quantity: "5" }),
      () => receiveStock({ itemId: paperId, quantity: 5, extra: 1 }),
      () => consumeStock({ itemId: paperId, quantity: -5 }),
      () => adjustStock({ itemId: paperId, quantity: 5 }), // no note
      () => adjustStock({ itemId: paperId, quantity: 5, note: "   " }),
      () => adjustStock({ itemId: paperId, quantity: 0, note: "جرد" }),
      () => adjustStock({ itemId: paperId, quantity: -1_000_001, note: "جرد" }),
    ];
    for (const call of bad) expect(await call()).toEqual({ ok: false, error: "validation" });
    expect(await receiveStock({ itemId: 999_999, quantity: 5 })).toEqual({ ok: false, error: "not_found" });
    expect(await movements(paperId)).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("keeps the sum when many movements land at once", async () => {
    actAs("admin");
    const calls = Array.from({ length: 24 }, (_, i) =>
      i % 3 === 0
        ? consumeStock({ itemId: paperId, quantity: 7 })
        : i % 3 === 1
          ? receiveStock({ itemId: paperId, quantity: 11 })
          : adjustStock({ itemId: paperId, quantity: -3, note: "جرد" }),
    );
    const results = await Promise.all(calls);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await balance(paperId)).toBe(8 * (11 - 7 - 3));
  });

  // ---- items

  it("creates toner, master roll and part items; refuses paper, a duplicate name and an archived machine", async () => {
    actAs("admin");
    const toner = await createInventoryItem({ name: "حبر M1", kind: "toner", unit: "علبة", machineId: m.M1, minQuantity: 2 });
    expect(toner).toEqual({ ok: true, item: { id: expect.any(Number) } });
    expect(await createInventoryItem({ name: "رول ماستر", kind: "master_roll", unit: "رول" })).toMatchObject({ ok: true });
    expect(await createInventoryItem({ name: "ورق آخر", kind: "paper", unit: "ورقة" })).toEqual({ ok: false, error: "validation" });
    expect(await createInventoryItem({ name: "حبر M1", kind: "toner", unit: "علبة" })).toEqual({ ok: false, error: "duplicate" });
    expect(await createInventoryItem({ name: "حبر قديم", kind: "toner", unit: "علبة", machineId: m.OLD })).toEqual({
      ok: false,
      error: "validation",
    });
    expect(await createInventoryItem({ name: "حبر ؟", kind: "toner", unit: "علبة", machineId: 999_999 })).toEqual({
      ok: false,
      error: "validation",
    });
    const list = await listInventory();
    expect(list.items.map((i) => [i.name, i.kind, i.machineName, i.minQuantity, i.balance])).toEqual([
      ["ورق A4", "paper", null, 0, 0],
      ["حبر M1", "toner", "M1", 2, 0],
      ["رول ماستر", "master_roll", null, 0, 0],
    ]);
  });

  it("updates an item as a patch; kind never changes; paper stays active and on no machine", async () => {
    actAs("admin");
    const toner = await newItem({ name: "حبر" });
    expect(await updateInventoryItem({ itemId: toner, name: "حبر أسود", minQuantity: 3, machineId: m.M2 })).toEqual({ ok: true });
    expect(await updateInventoryItem({ itemId: toner, machineId: null, isActive: false })).toEqual({ ok: true });
    const [row] = await getDb().select().from(inventoryItems).where(eq(inventoryItems.id, toner));
    expect(row).toMatchObject({ name: "حبر أسود", minQuantity: 3, machineId: null, isActive: false, kind: "toner" });

    expect(await updateInventoryItem({ itemId: toner, kind: "part" })).toEqual({ ok: false, error: "validation" });
    expect(await updateInventoryItem({ itemId: toner })).toEqual({ ok: false, error: "validation" });
    expect(await updateInventoryItem({ itemId: toner, machineId: m.OLD })).toEqual({ ok: false, error: "validation" });
    expect(await updateInventoryItem({ itemId: toner, name: "ورق A4" })).toEqual({ ok: false, error: "duplicate" });
    expect(await updateInventoryItem({ itemId: 999_999, name: "x" })).toEqual({ ok: false, error: "not_found" });
    expect(await updateInventoryItem({ itemId: paperId, isActive: false })).toEqual({ ok: false, error: "refused" });
    expect(await updateInventoryItem({ itemId: paperId, machineId: m.M1 })).toEqual({ ok: false, error: "validation" });
    expect(await updateInventoryItem({ itemId: paperId, minQuantity: 10_000, isActive: true })).toEqual({ ok: true });
  });

  it("will not deactivate an item an installed part uses, nor tie it to another machine", async () => {
    actAs("admin");
    const drum = await newItem({ kind: "part", unit: "قطعة" });
    const p = await newPart(m.M1, { inventoryItemId: drum });
    expect(await updateInventoryItem({ itemId: drum, isActive: false })).toEqual({ ok: false, error: "in_use" });
    expect(await updateInventoryItem({ itemId: drum, machineId: m.M2 })).toEqual({ ok: false, error: "in_use" });
    expect(await updateInventoryItem({ itemId: drum, machineId: m.M1 })).toEqual({ ok: true });
    await getDb().update(machineParts).set({ replacedAt: NOW, replacedBy: ids.admin }).where(eq(machineParts.id, p));
    expect(await updateInventoryItem({ itemId: drum, isActive: false })).toEqual({ ok: true });
  });

  // ---- parts

  it("adds a part at 0; refuses an archived machine and a stock item that is not a part of this machine", async () => {
    actAs("admin");
    const drum = await newItem({ kind: "part", unit: "قطعة", machineId: m.M1 });
    const anyDrum = await newItem({ kind: "part", unit: "قطعة" });
    const toner = await newItem();
    const off = await newItem({ kind: "part", unit: "قطعة", isActive: false });

    const added = await addMachinePart({ machineId: m.M1, name: "درم", lifeImpressions: 100_000, inventoryItemId: drum });
    expect(added).toEqual({ ok: true, part: { id: expect.any(Number) } });
    expect(await addMachinePart({ machineId: m.M2, name: "فيوزر", lifeImpressions: 50_000, inventoryItemId: anyDrum })).toMatchObject({
      ok: true,
    });
    expect(await addMachinePart({ machineId: m.M2, name: "بكرة", lifeImpressions: 9 })).toMatchObject({ ok: true });

    const refused = [
      { machineId: m.OLD, name: "درم", lifeImpressions: 10 },
      { machineId: 999_999, name: "درم", lifeImpressions: 10 },
      { machineId: m.M2, name: "درم", lifeImpressions: 10, inventoryItemId: drum }, // item of M1
      { machineId: m.M1, name: "درم", lifeImpressions: 10, inventoryItemId: toner }, // not a part
      { machineId: m.M1, name: "درم", lifeImpressions: 10, inventoryItemId: off }, // inactive
      { machineId: m.M1, name: "درم", lifeImpressions: 0 },
      { machineId: m.M1, name: "", lifeImpressions: 10 },
    ];
    for (const input of refused) expect(await addMachinePart(input)).toEqual({ ok: false, error: "validation" });

    const row = await part((added as { part: { id: number } }).part.id);
    expect(row).toMatchObject({ machineId: m.M1, impressionsUsed: 0, replacedAt: null, inventoryItemId: drum });
    expect((await audits()).map((a) => a.action)).toEqual(["part.add", "part.add", "part.add"]);
    expect((await parts({ machineId: m.M2 })).map((p) => p.name).sort()).toEqual(["بكرة", "فيوزر"]);
  });

  it("replaces a part: old row closed, new row at 0 with the same name, consume −1 of its spare", async () => {
    actAs("admin");
    const drum = await newItem({ kind: "part", unit: "قطعة" });
    await receiveStock({ itemId: drum, quantity: 3 });
    const old = await newPart(m.M1, { inventoryItemId: drum, impressionsUsed: 950 });

    const r = await replaceMachinePart({ partId: old });
    expect(r).toEqual({ ok: true, part: { id: expect.any(Number) }, movementId: expect.any(Number) });
    const newId = (r as { part: { id: number } }).part.id;

    expect(await part(old)).toMatchObject({ replacedAt: NOW, replacedBy: ids.admin, impressionsUsed: 950 });
    expect(await part(newId)).toMatchObject({
      machineId: m.M1,
      name: "درم",
      inventoryItemId: drum,
      lifeImpressions: 1000,
      impressionsUsed: 0,
      replacedAt: null,
      installedAt: NOW,
    });
    expect((await movements(drum)).at(-1)).toMatchObject({ type: "consume", quantity: -1, machinePartId: newId });
    expect(await balance(drum)).toBe(2);
    expect((await audits()).at(-1)).toMatchObject({
      action: "part.replace",
      entityId: String(newId),
      details: { oldPartId: old, oldImpressionsUsed: 950, lifeImpressions: 1000, machineId: m.M1, name: "درم", inventoryItemId: drum },
    });

    actAs("admin");
    expect(await replaceMachinePart({ partId: old })).toEqual({ ok: false, error: "refused" });
    expect(await replaceMachinePart({ partId: 999_999 })).toEqual({ ok: false, error: "not_found" });
    expect(await replaceMachinePart({ partId: newId, lifeImpressions: 0 })).toEqual({ ok: false, error: "validation" });

    const listed = await parts({ machineId: m.M1, includeReplaced: true });
    expect(listed.map((p) => [p.id, p.replacedByName])).toEqual([
      [newId, null],
      [old, "مسؤول"],
    ]);
    expect((await parts({ machineId: m.M1 })).map((p) => p.id)).toEqual([newId]);
  });

  it("replaces with another life when given, and writes no movement for an untracked part", async () => {
    actAs("admin");
    const old = await newPart(m.M2);
    const r = await replaceMachinePart({ partId: old, lifeImpressions: 250_000 });
    expect(r).toMatchObject({ ok: true, movementId: null });
    expect(await part((r as { part: { id: number } }).part.id)).toMatchObject({ lifeImpressions: 250_000, impressionsUsed: 0 });
    expect(await getDb().select().from(inventoryMovements)).toEqual([]);
  });

  it("two replaces of one part at once: one lands, the other is refused", async () => {
    actAs("admin");
    const drum = await newItem({ kind: "part", unit: "قطعة" });
    const old = await newPart(m.M1, { inventoryItemId: drum });
    const results = await Promise.all([replaceMachinePart({ partId: old }), replaceMachinePart({ partId: old })]);
    expect(results.map((r) => r.ok).sort()).toEqual([false, true]);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: "refused" });
    const installed = await getDb()
      .select()
      .from(machineParts)
      .where(and(eq(machineParts.machineId, m.M1), isNull(machineParts.replacedAt)));
    expect(installed).toHaveLength(1);
    expect(await balance(drum)).toBe(-1);
  });

  // ---- T3 markReady

  it("markReady: paper consume −sheets and waste −wasted, once, with the booking; counters on installed parts", async () => {
    actAs("admin");
    await receiveStock({ itemId: paperId, quantity: 1000 });
    const drum = await newPart(m.M1, { impressionsUsed: 10 });
    const fuser = await newPart(m.M1, { name: "فيوزر" });
    const gone = await newPart(m.M1, { replacedAt: NOW, replacedBy: ids.admin, impressionsUsed: 5 });
    const other = await newPart(m.M2);
    // duplex: sheets = 3 × 2 × ceil(5 / 2) = 18, impressions = 3 × 2 × 5 = 30
    const id = await insertBooking("in_progress", { copies: 3, models: 2, pagesPerModel: 5, sides: "duplex" });

    actAs("operator");
    expect(await markReady({ bookingId: id, wastedSheets: 4, wasteDestroyed: true })).toMatchObject({ ok: true });

    const paperRows = (await movements(paperId)).filter((x) => x.bookingId === id);
    expect(paperRows.map((x) => [x.type, x.quantity, x.createdBy])).toEqual([
      ["consume", -18, ids.operator],
      ["waste", -4, ids.operator],
    ]);
    expect(await balance(paperId)).toBe(1000 - 18 - 4);
    expect((await part(drum)).impressionsUsed).toBe(40);
    expect((await part(fuser)).impressionsUsed).toBe(30);
    expect((await part(gone)).impressionsUsed).toBe(5);
    expect((await part(other)).impressionsUsed).toBe(0);

    actAs("operator"); // a second call is refused by the transition guard: nothing counted twice
    expect(await markReady({ bookingId: id, wastedSheets: 4, wasteDestroyed: true })).toEqual({ ok: false, error: "refused" });
    expect((await movements(paperId)).filter((x) => x.bookingId === id)).toHaveLength(2);
    expect((await part(drum)).impressionsUsed).toBe(40);
  });

  it("markReady with no waste writes one paper row, and is never blocked by stock", async () => {
    const id = await insertBooking("in_progress");
    actAs("operator");
    expect(await markReady({ bookingId: id, wastedSheets: 0, wasteDestroyed: true })).toMatchObject({ ok: true });
    expect((await movements(paperId)).map((x) => [x.type, x.quantity])).toEqual([["consume", -200]]);
    expect(await balance(paperId)).toBe(-200);
  });

  it("markReady with no paper item (an emptied database) still makes the job ready and counts the parts", async () => {
    await getDb().delete(inventoryItems).where(eq(inventoryItems.id, paperId));
    const drum = await newPart(m.M1);
    const id = await insertBooking("in_progress");
    actAs("operator");
    expect(await markReady({ bookingId: id, wastedSheets: 2, wasteDestroyed: true })).toMatchObject({ ok: true });
    expect(await getDb().select().from(inventoryMovements)).toEqual([]);
    expect((await part(drum)).impressionsUsed).toBe(200);
  });

  it("a replace racing markReady counts the job on exactly one of the two parts", async () => {
    for (let round = 0; round < 4; round++) {
      const old = await newPart(m.M1, { name: `درم ${round}` });
      const id = await insertBooking("in_progress");
      actAs("admin");
      const [ready, replaced] = await Promise.all([
        markReady({ bookingId: id, wastedSheets: 0, wasteDestroyed: true }),
        replaceMachinePart({ partId: old }),
      ]);
      expect(ready.ok && replaced.ok).toBe(true);
      const newId = (replaced as { part: { id: number } }).part.id;
      expect((await part(old)).impressionsUsed + (await part(newId)).impressionsUsed).toBe(200);
    }
  });

  // ---- alerts

  it("low_stock: an active item at or under its minimum", async () => {
    actAs("admin");
    await updateInventoryItem({ itemId: paperId, minQuantity: 500 });
    await receiveStock({ itemId: paperId, quantity: 501 });
    const toner = await newItem({ minQuantity: 2 });
    await receiveStock({ itemId: toner, quantity: 2 });
    await newItem({ minQuantity: 5, isActive: false }); // inactive: never alerts
    const plenty = await newItem({ minQuantity: 1 });
    await receiveStock({ itemId: plenty, quantity: 9 });

    expect((await getStockAlerts()).alerts).toEqual([{ kind: "low_stock", itemId: toner }]);
    await consumeStock({ itemId: paperId, quantity: 1 });
    expect((await getStockAlerts()).alerts).toEqual([
      { kind: "low_stock", itemId: paperId },
      { kind: "low_stock", itemId: toner },
    ]);
  });

  it("part_near_end: an installed part at part_warn_percent of its life, on a machine in use", async () => {
    actAs("admin");
    await receiveStock({ itemId: paperId, quantity: 1 }); // keep paper out of low_stock
    const at90 = await newPart(m.M1, { lifeImpressions: 1000, impressionsUsed: 900 });
    await newPart(m.M1, { lifeImpressions: 1000, impressionsUsed: 899 });
    await newPart(m.M1, { lifeImpressions: 1000, impressionsUsed: 1200, replacedAt: NOW, replacedBy: ids.admin });
    await newPart(m.OLD, { lifeImpressions: 1000, impressionsUsed: 1000 });
    const big = await newPart(m.M2, { lifeImpressions: 2_000_000_000, impressionsUsed: 1_900_000_000 }); // no overflow
    expect((await getStockAlerts()).alerts).toEqual([
      { kind: "part_near_end", machinePartId: at90 },
      { kind: "part_near_end", machinePartId: big },
    ]);
    await getDb().update(settings).set({ value: 100 }).where(eq(settings.key, "part_warn_percent"));
    expect((await getStockAlerts()).alerts).toEqual([]);
  });

  it("paper_short: a date to today + suggestion_search_days whose booked + in_progress sheets exceed the balance", async () => {
    actAs("admin");
    await receiveStock({ itemId: paperId, quantity: 300 });
    await insertBooking("booked"); // today 200
    await insertBooking("ready"); // today, not counted
    await insertBooking("cancelled", {}, addDays(TODAY, 1));
    await insertBooking("booked", {}, addDays(TODAY, 1)); // +1: 200 + 200 in progress = 400 > 300
    await insertBooking("in_progress", {}, addDays(TODAY, 1));
    await insertBooking("booked", { copies: 200 }, addDays(TODAY, 14)); // 400, the last day searched
    await insertBooking("booked", { copies: 200 }, addDays(TODAY, 15)); // past the window
    await insertBooking("booked", { copies: 200 }, addDays(TODAY, -1)); // yesterday

    expect((await getStockAlerts()).alerts).toEqual([
      { kind: "paper_short", itemId: paperId, date: addDays(TODAY, 1) },
      { kind: "paper_short", itemId: paperId, date: addDays(TODAY, 14) },
    ]);
    await receiveStock({ itemId: paperId, quantity: 100 }); // 400: no day exceeds it
    expect((await getStockAlerts()).alerts).toEqual([]);
  });

  // ---- listMovements

  it("lists movements newest first, by item and by business dates, at most 500", async () => {
    actAs("admin");
    const toner = await newItem({ name: "حبر" });
    const a = await receiveStock({ itemId: paperId, quantity: 10 });
    const b = await receiveStock({ itemId: toner, quantity: 1 });
    const c = await consumeStock({ itemId: paperId, quantity: 3, note: "تجربة" });
    const stamp = async (r: typeof a, when: Date) =>
      getDb()
        .update(inventoryMovements)
        .set({ createdAt: when })
        .where(eq(inventoryMovements.id, (r as { movementId: number }).movementId));
    const yesterday = addDays(TODAY, -1);
    await stamp(a, atMinutes(yesterday, 23 * 60 + 50)); // 23:50 Tripoli = 21:50 UTC
    await stamp(b, atMinutes(TODAY, 30)); // 00:30 Tripoli = the day before in UTC
    await stamp(c, atMinutes(TODAY, 9 * 60));

    const all = await listMovements();
    expect(all.ok && all.items.map((x) => [x.itemName, x.type, x.quantity, x.note, x.createdByName])).toEqual([
      ["ورق A4", "consume", -3, "تجربة", "مسؤول"],
      ["حبر", "receive", 1, null, "مسؤول"],
      ["ورق A4", "receive", 10, null, "مسؤول"],
    ]);
    const paperOnly = await listMovements({ itemId: paperId });
    expect(paperOnly.ok && paperOnly.items.map((x) => x.quantity)).toEqual([-3, 10]);
    const day = await listMovements({ from: TODAY, to: TODAY });
    expect(day.ok && day.items.map((x) => x.quantity)).toEqual([-3, 1]);
    const before = await listMovements({ to: yesterday });
    expect(before.ok && before.items.map((x) => x.quantity)).toEqual([10]);
    expect(await listMovements({ from: TODAY, to: yesterday })).toEqual({ ok: false, error: "validation" });
    expect(await listMovements({ from: "2026-02-30" })).toEqual({ ok: false, error: "validation" });
    expect(await listMovements({ itemId: 0 })).toEqual({ ok: false, error: "validation" });

    await getDb()
      .insert(inventoryMovements)
      .values(Array.from({ length: 520 }, () => ({ itemId: toner, type: "receive" as const, quantity: 1, createdBy: ids.admin })));
    const capped = await listMovements();
    expect(capped.ok && capped.items).toHaveLength(500);
  });

  it("shows the booking reference on markReady movements", async () => {
    const id = await insertBooking("in_progress");
    actAs("operator");
    await markReady({ bookingId: id, wastedSheets: 0, wasteDestroyed: true });
    actAs("admin");
    const list = await listMovements({ itemId: paperId });
    expect(list.ok && list.items.map((x) => [x.bookingId, x.bookingReference])).toEqual([[id, "2026-0001"]]);
  });
});
