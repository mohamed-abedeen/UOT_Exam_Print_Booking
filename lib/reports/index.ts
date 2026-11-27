// Reports (contracts §4 "Reports and audit", §8.38). Admin only; the server actions in lib/actions/reports.ts run the
// role guard and call these. Read-only: nothing is written, no lock is taken. Not a "use server" file.
// Every range is two business dates, both inclusive (like `listMovements`). Bookings are counted by the business
// date of `starts_at`; "holding" = every status except `cancelled` and `no_show` (§0).
import "server-only";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { bookings, colleges, inventoryItems, inventoryMovements, machineMaintenance, machines } from "@/db/schema";
import { AuthError, type Actor } from "@/lib/auth/guard";
import { dateString, VALIDATION } from "@/lib/bookings/create";
import { addDays, atMinutes, TZ_OFFSET_MINUTES } from "@/lib/scheduling/time";
import { downtimeMinutes } from "./downtime";

const rangeInput = z.strictObject({ from: dateString, to: dateString }).refine((v) => v.from <= v.to);

function requireAdmin(actor: Actor): void {
  if (actor.role !== "admin") throw new AuthError();
}

/** [from 00:00, day after `to` 00:00) in business time. */
function bounds(range: { from: string; to: string }): { start: Date; end: Date } {
  return { start: atMinutes(range.from, 0), end: atMinutes(addDays(range.to, 1), 0) };
}

const HOLDING = ["cancelled", "no_show"] as const; // for notInArray
const total = (column: unknown) => sql<number>`coalesce(sum(${column}), 0)::float8`;
const count = sql<number>`count(*)::int`;

export type ReportInput = { from: string; to: string };
type Failed = { ok: false; error: "validation" };

// ---- reportByCollege

export interface CollegeReportRow {
  collegeId: number;
  collegeName: string;
  bookings: number; // holding bookings starting in the range
  impressions: number;
  sheets: number;
  cancelled: number;
  noShows: number;
  delayNotices: number; // by the date of `delay_notice_at`
}
export type CollegeReportResult = { ok: true; rows: CollegeReportRow[]; totals: Omit<CollegeReportRow, "collegeId" | "collegeName"> } | Failed;

/**
 * One row per college with at least one booking starting in the range or a delay notice sent in it, most impressions
 * first. Cancelled and no-show bookings are counted in their own columns and add no impressions or sheets (§8.38).
 */
export async function reportByCollegeFor(actor: Actor, from: unknown, to: unknown): Promise<CollegeReportResult> {
  requireAdmin(actor);
  const parsed = rangeInput.safeParse({ from, to });
  if (!parsed.success) return VALIDATION;
  const { start, end } = bounds(parsed.data);
  const db = getDb();

  const byStatus = await db
    .select({
      collegeId: bookings.collegeId,
      status: bookings.status,
      n: count,
      impressions: total(bookings.impressions),
      sheets: total(bookings.sheets),
    })
    .from(bookings)
    .where(and(gte(bookings.startsAt, start), lt(bookings.startsAt, end)))
    .groupBy(bookings.collegeId, bookings.status);
  const notices = await db
    .select({ collegeId: bookings.collegeId, n: count })
    .from(bookings)
    .where(and(isNotNull(bookings.delayNoticeAt), gte(bookings.delayNoticeAt, start), lt(bookings.delayNoticeAt, end)))
    .groupBy(bookings.collegeId);

  const byCollege = new Map<number, CollegeReportRow>();
  const rowOf = (collegeId: number): CollegeReportRow => {
    let row = byCollege.get(collegeId);
    if (!row) {
      row = { collegeId, collegeName: "", bookings: 0, impressions: 0, sheets: 0, cancelled: 0, noShows: 0, delayNotices: 0 };
      byCollege.set(collegeId, row);
    }
    return row;
  };
  for (const r of byStatus) {
    const row = rowOf(r.collegeId);
    if (r.status === "cancelled") row.cancelled += r.n;
    else if (r.status === "no_show") row.noShows += r.n;
    else {
      row.bookings += r.n;
      row.impressions += r.impressions;
      row.sheets += r.sheets;
    }
  }
  for (const r of notices) rowOf(r.collegeId).delayNotices += r.n;

  const ids = [...byCollege.keys()];
  const names = ids.length
    ? await db.select({ id: colleges.id, name: colleges.name }).from(colleges).where(inArray(colleges.id, ids))
    : [];
  for (const n of names) rowOf(n.id).collegeName = n.name;

  const rows = [...byCollege.values()].sort(
    (a, b) => b.impressions - a.impressions || a.collegeName.localeCompare(b.collegeName, "ar"),
  );
  const totals = rows.reduce(
    (t, r) => ({
      bookings: t.bookings + r.bookings,
      impressions: t.impressions + r.impressions,
      sheets: t.sheets + r.sheets,
      cancelled: t.cancelled + r.cancelled,
      noShows: t.noShows + r.noShows,
      delayNotices: t.delayNotices + r.delayNotices,
    }),
    { bookings: 0, impressions: 0, sheets: 0, cancelled: 0, noShows: 0, delayNotices: 0 },
  );
  return { ok: true, rows, totals };
}

// ---- reportByMachine

export interface MachineReportRow {
  machineId: number;
  machineName: string;
  archived: boolean;
  bookings: number; // holding bookings starting in the range
  impressions: number;
  bookedMinutes: number; // sum of `ends_at − starts_at` of those bookings
  downtimeMinutes: number; // §8.38: the machine's maintenance windows clipped to the range
}
export type MachineReportResult =
  | { ok: true; rows: MachineReportRow[]; totals: Pick<MachineReportRow, "bookings" | "impressions" | "bookedMinutes" | "downtimeMinutes"> }
  | Failed;

/**
 * Every active machine, plus an archived one that has a booking or downtime in the range. Downtime: each
 * `machine_maintenance` window clipped to the range; one with no end runs to now; a planned window inside the range
 * counts in full (§8.38).
 */
export async function reportByMachineFor(actor: Actor, from: unknown, to: unknown, now = new Date()): Promise<MachineReportResult> {
  requireAdmin(actor);
  const parsed = rangeInput.safeParse({ from, to });
  if (!parsed.success) return VALIDATION;
  const { start, end } = bounds(parsed.data);
  const db = getDb();

  const [list, booked, windows] = await Promise.all([
    db.select({ id: machines.id, name: machines.name, archivedAt: machines.archivedAt }).from(machines).orderBy(asc(machines.id)),
    db
      .select({
        machineId: bookings.machineId,
        n: count,
        impressions: total(bookings.impressions),
        minutes: total(sql`extract(epoch from (${bookings.endsAt} - ${bookings.startsAt})) / 60`),
      })
      .from(bookings)
      .where(and(gte(bookings.startsAt, start), lt(bookings.startsAt, end), notInArray(bookings.status, [...HOLDING])))
      .groupBy(bookings.machineId),
    db
      .select({ machineId: machineMaintenance.machineId, startsAt: machineMaintenance.startsAt, endsAt: machineMaintenance.endsAt })
      .from(machineMaintenance)
      .where(
        and(
          lt(machineMaintenance.startsAt, end),
          or(isNull(machineMaintenance.endsAt), gt(machineMaintenance.endsAt, start)),
        ),
      ),
  ]);

  const rows: MachineReportRow[] = [];
  for (const m of list) {
    const b = booked.find((x) => x.machineId === m.id);
    const down = downtimeMinutes(windows.filter((w) => w.machineId === m.id), start, end, now);
    const archived = m.archivedAt !== null;
    if (archived && !b && down === 0) continue;
    rows.push({
      machineId: m.id,
      machineName: m.name,
      archived,
      bookings: b?.n ?? 0,
      impressions: b?.impressions ?? 0,
      bookedMinutes: Math.round(b?.minutes ?? 0),
      downtimeMinutes: down,
    });
  }
  const totals = rows.reduce(
    (t, r) => ({
      bookings: t.bookings + r.bookings,
      impressions: t.impressions + r.impressions,
      bookedMinutes: t.bookedMinutes + r.bookedMinutes,
      downtimeMinutes: t.downtimeMinutes + r.downtimeMinutes,
    }),
    { bookings: 0, impressions: 0, bookedMinutes: 0, downtimeMinutes: 0 },
  );
  return { ok: true, rows, totals };
}

// ---- reportWasteAndStock

export interface StockReportRow {
  itemId: number;
  itemName: string;
  unit: string;
  receive: number; // signed sums of the item's movements in the range, by type
  consume: number;
  waste: number;
  adjust: number;
  net: number;
}
export interface WasteReport {
  bookings: number; // ready or delivered, `ready_at` in the range
  sheets: number; // their sheets
  wastedSheets: number; // `wasted_sheets` of those
}
export type WasteAndStockResult = { ok: true; waste: WasteReport; items: StockReportRow[] } | Failed;

/**
 * `wasted_sheets` of the bookings finished (`ready_at`) in the range, and the stock movements made in it, by item and
 * type (signed, as stored). One row per item with at least one movement, by name.
 */
export async function reportWasteAndStockFor(actor: Actor, from: unknown, to: unknown): Promise<WasteAndStockResult> {
  requireAdmin(actor);
  const parsed = rangeInput.safeParse({ from, to });
  if (!parsed.success) return VALIDATION;
  const { start, end } = bounds(parsed.data);
  const db = getDb();

  const [[waste], moves] = await Promise.all([
    db
      .select({ n: count, sheets: total(bookings.sheets), wasted: total(bookings.wastedSheets) })
      .from(bookings)
      .where(
        and(
          inArray(bookings.status, ["ready", "delivered"]),
          isNotNull(bookings.readyAt),
          gte(bookings.readyAt, start),
          lt(bookings.readyAt, end),
        ),
      ),
    db
      .select({
        itemId: inventoryMovements.itemId,
        itemName: inventoryItems.name,
        unit: inventoryItems.unit,
        type: inventoryMovements.type,
        quantity: total(inventoryMovements.quantity),
      })
      .from(inventoryMovements)
      .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryMovements.itemId))
      .where(and(gte(inventoryMovements.createdAt, start), lt(inventoryMovements.createdAt, end)))
      .groupBy(inventoryMovements.itemId, inventoryItems.name, inventoryItems.unit, inventoryMovements.type),
  ]);

  const byItem = new Map<number, StockReportRow>();
  for (const m of moves) {
    let row = byItem.get(m.itemId);
    if (!row) {
      row = { itemId: m.itemId, itemName: m.itemName, unit: m.unit, receive: 0, consume: 0, waste: 0, adjust: 0, net: 0 };
      byItem.set(m.itemId, row);
    }
    row[m.type] += m.quantity;
    row.net += m.quantity;
  }
  const items = [...byItem.values()].sort((a, b) => a.itemName.localeCompare(b.itemName, "ar"));
  return { ok: true, waste: { bookings: waste.n, sheets: waste.sheets, wastedSheets: waste.wasted }, items };
}

// ---- reportPeakHours

export interface PeakHourRow {
  hour: number; // 0–23, business time
  bookings: number;
  impressions: number;
}
export type PeakHoursResult = { ok: true; rows: PeakHourRow[] } | Failed;

/** Holding bookings by the business hour of `starts_at`; only hours that have bookings, earliest first. */
export async function reportPeakHoursFor(actor: Actor, from: unknown, to: unknown): Promise<PeakHoursResult> {
  requireAdmin(actor);
  const parsed = rangeInput.safeParse({ from, to });
  if (!parsed.success) return VALIDATION;
  const { start, end } = bounds(parsed.data);
  // The offset is a literal, not a parameter: a parameter in the select list and another in GROUP BY are two different
  // values to PostgreSQL, and the select list would then not match the grouping.
  const hour = sql<number>`extract(hour from (${bookings.startsAt} at time zone 'UTC') + make_interval(mins => ${sql.raw(String(TZ_OFFSET_MINUTES))}))::int`;
  const rows = await getDb()
    .select({ hour, bookings: count, impressions: total(bookings.impressions) })
    .from(bookings)
    .where(and(gte(bookings.startsAt, start), lt(bookings.startsAt, end), notInArray(bookings.status, [...HOLDING])))
    .groupBy(hour)
    .orderBy(asc(hour));
  return { ok: true, rows };
}
