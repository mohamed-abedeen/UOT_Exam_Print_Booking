// Stock (contracts §1.6, §1.9, §1.10, §3.10 getStockAlerts, §4 "Stock"). Admin only; the server actions in
// lib/actions/stock.ts run the role guard and call these. Not a "use server" file.
// Every change of a quantity is one append-only movement row; a balance is always the sum of an item's movements
// (no balance column). Stock may go negative and never blocks `ready` (§8.12).
// The installed parts of one machine are serialised by its `machines` row: adding or replacing a part takes it
// FOR UPDATE, `markReady` takes it FOR KEY SHARE before raising the counters (so a job is counted on exactly one
// part when a replace races it; two `markReady`s and machine edits do not wait for each other).
import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Executor, type Tx } from "@/db";
import { bookings, inventoryItems, inventoryMovements, machineParts, machines, users } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import { AuthError, type Actor } from "@/lib/auth/guard";
import { dateString, VALIDATION } from "@/lib/bookings/create";
import { loadSettings } from "@/lib/scheduling/load";
import { addDays, atMinutes, localDate } from "@/lib/scheduling/time";

export type ItemKind = "paper" | "toner" | "master_roll" | "part";
export type MovementType = "receive" | "consume" | "waste" | "adjust";
export interface StockAlert {
  kind: "low_stock" | "part_near_end" | "paper_short";
  itemId?: number;
  machinePartId?: number;
  date?: string;
}

const INT_MAX = 2_147_483_647;
const MOVE_MAX = 1_000_000; // one movement, either sign (owner, 2026-11-27, step 3.1)
/** Movements returned by one `listMovements` call, newest first (owner, 2026-11-27, step 3.1). */
export const MOVEMENTS_LIMIT = 500;

const rowId = z.number().int().positive();
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !s.includes("\u0000")); // PostgreSQL text cannot hold it
const quantity = z.number().int().min(1).max(MOVE_MAX);
const note = text(500);

function requireAdmin(actor: Actor): void {
  if (actor.role !== "admin") throw new AuthError();
}

/** The name of the unique constraint a failed write hit, or null. Drizzle wraps the driver error in `cause`. */
function uniqueViolation(error: unknown): string | null {
  type PgError = { code?: unknown; constraint_name?: unknown; cause?: unknown };
  for (let e = error as PgError | null | undefined, depth = 0; e && depth < 10; depth++) {
    if (e.code === "23505") return typeof e.constraint_name === "string" ? e.constraint_name : "";
    e = e.cause as typeof e;
  }
  return null;
}

/**
 * sum(quantity) of an item's movements, as a JS number: of the item with this id, or (no id) of the `inventory_items`
 * row of the outer query. Spelled out in SQL: Drizzle leaves a column unqualified in a one-table select, and an
 * unqualified "id" inside the subquery would be the movement's own id.
 */
const balanceOf = (itemId?: number) =>
  sql<number>`(SELECT coalesce(sum(mv.quantity), 0) FROM inventory_movements mv WHERE mv.item_id = ${
    itemId === undefined ? sql.raw('"inventory_items"."id"') : itemId
  })`.mapWith(Number);

/** The balance of one item: the sum of its movements (contracts §1.10). */
export async function itemBalance(ex: Executor, itemId: number): Promise<number> {
  const [row] = await ex.select({ balance: balanceOf(itemId) }).from(inventoryItems).where(eq(inventoryItems.id, itemId));
  return row?.balance ?? 0;
}

/** An existing machine that is not archived, or null. */
async function activeMachine(ex: Executor, machineId: number): Promise<{ id: number; name: string } | null> {
  const [m] = await ex
    .select({ id: machines.id, name: machines.name })
    .from(machines)
    .where(and(eq(machines.id, machineId), isNull(machines.archivedAt)));
  return m ?? null;
}

// ---- listInventory

export interface InventoryItem {
  id: number;
  name: string;
  kind: ItemKind;
  unit: string;
  machineId: number | null;
  machineName: string | null;
  minQuantity: number;
  isActive: boolean;
  balance: number;
}
export type ListInventoryResult = { ok: true; items: InventoryItem[] };

/** Every item, inactive ones too: active first, then by kind and name; balance = sum of movements. */
export async function listInventoryFor(actor: Actor): Promise<ListInventoryResult> {
  requireAdmin(actor);
  const items = await getDb()
    .select({
      id: inventoryItems.id,
      name: inventoryItems.name,
      kind: inventoryItems.kind,
      unit: inventoryItems.unit,
      machineId: inventoryItems.machineId,
      machineName: machines.name,
      minQuantity: inventoryItems.minQuantity,
      isActive: inventoryItems.isActive,
      balance: balanceOf(),
    })
    .from(inventoryItems)
    .leftJoin(machines, eq(machines.id, inventoryItems.machineId))
    .orderBy(desc(inventoryItems.isActive), asc(inventoryItems.kind), asc(inventoryItems.name), asc(inventoryItems.id));
  return { ok: true, items };
}

// ---- listMovements

const listMovementsInput = z
  .strictObject({ itemId: rowId.optional(), from: dateString.optional(), to: dateString.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to);

export interface MovementRow {
  id: number;
  itemId: number;
  itemName: string;
  type: MovementType;
  quantity: number;
  bookingId: number | null;
  bookingReference: string | null;
  machinePartId: number | null;
  note: string | null;
  createdByName: string;
  createdAt: Date;
}
export type ListMovementsResult = { ok: true; items: MovementRow[] } | { ok: false; error: "validation" };

/**
 * Newest first, at most `MOVEMENTS_LIMIT` rows (owner, 2026-11-27, step 3.1). Optional `itemId`; optional `from` /
 * `to` business dates, both inclusive.
 */
export async function listMovementsFor(actor: Actor, input: unknown = {}): Promise<ListMovementsResult> {
  requireAdmin(actor);
  const parsed = listMovementsInput.safeParse(input ?? {});
  if (!parsed.success) return VALIDATION;
  const { itemId, from, to } = parsed.data;
  const items = await getDb()
    .select({
      id: inventoryMovements.id,
      itemId: inventoryMovements.itemId,
      itemName: inventoryItems.name,
      type: inventoryMovements.type,
      quantity: inventoryMovements.quantity,
      bookingId: inventoryMovements.bookingId,
      bookingReference: bookings.reference,
      machinePartId: inventoryMovements.machinePartId,
      note: inventoryMovements.note,
      createdByName: users.fullName,
      createdAt: inventoryMovements.createdAt,
    })
    .from(inventoryMovements)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryMovements.itemId))
    .innerJoin(users, eq(users.id, inventoryMovements.createdBy))
    .leftJoin(bookings, eq(bookings.id, inventoryMovements.bookingId))
    .where(
      and(
        itemId ? eq(inventoryMovements.itemId, itemId) : undefined,
        from ? gte(inventoryMovements.createdAt, atMinutes(from, 0)) : undefined,
        to ? lt(inventoryMovements.createdAt, atMinutes(addDays(to, 1), 0)) : undefined,
      ),
    )
    .orderBy(desc(inventoryMovements.createdAt), desc(inventoryMovements.id))
    .limit(MOVEMENTS_LIMIT);
  return { ok: true, items };
}

// ---- createInventoryItem, updateInventoryItem (not audited: contracts §6 names no action for them)

const createItemInput = z.strictObject({
  name: text(100),
  kind: z.enum(["toner", "master_roll", "part"]), // the one paper item is seeded and never created (§1.9)
  unit: text(30),
  machineId: rowId.nullable().optional(),
  minQuantity: z.number().int().min(0).max(INT_MAX).optional(),
});

export type CreateItemResult =
  | { ok: true; item: { id: number } }
  | { ok: false; error: "validation" | "duplicate" }; // validation also = an unknown or archived machine

/** A toner, master roll or spare part item; optionally tied to one machine that is not archived. */
export async function createInventoryItemFor(actor: Actor, input: unknown): Promise<CreateItemResult> {
  requireAdmin(actor);
  const parsed = createItemInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const v = parsed.data;
  return getDb().transaction(async (tx): Promise<CreateItemResult> => {
    if (v.machineId != null && !(await activeMachine(tx, v.machineId))) return VALIDATION;
    const [row] = await tx
      .insert(inventoryItems)
      .values({ name: v.name, kind: v.kind, unit: v.unit, machineId: v.machineId ?? null, minQuantity: v.minQuantity ?? 0 })
      .onConflictDoNothing({ target: inventoryItems.name })
      .returning({ id: inventoryItems.id });
    if (!row) return { ok: false, error: "duplicate" };
    return { ok: true, item: row };
  });
}

const updateItemInput = z
  .strictObject({
    itemId: rowId,
    name: text(100).optional(),
    unit: text(30).optional(),
    machineId: rowId.nullable().optional(),
    minQuantity: z.number().int().min(0).max(INT_MAX).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 1);

export type UpdateItemResult =
  | { ok: true }
  | { ok: false; error: "validation" | "not_found" | "duplicate" }
  | { ok: false; error: "refused" } // the paper item cannot be deactivated
  | { ok: false; error: "in_use" }; // an installed part uses this item (deactivate, or tie it to another machine)

/**
 * A partial patch; `kind` never changes (owner, 2026-11-27, step 3.1). Paper stays active and on no machine. An item
 * that an installed part uses cannot be deactivated nor tied to a machine other than that part's.
 */
export async function updateInventoryItemFor(actor: Actor, input: unknown): Promise<UpdateItemResult> {
  requireAdmin(actor);
  const parsed = updateItemInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const { itemId, ...patch } = parsed.data;
  try {
    return await getDb().transaction(async (tx): Promise<UpdateItemResult> => {
      const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, itemId)).for("update");
      if (!item) return { ok: false, error: "not_found" };
      if (item.kind === "paper") {
        if (patch.isActive === false) return { ok: false, error: "refused" };
        if (patch.machineId != null) return VALIDATION;
      }
      if (patch.machineId != null && patch.machineId !== item.machineId && !(await activeMachine(tx, patch.machineId))) {
        return VALIDATION;
      }
      const machineId = patch.machineId === undefined ? item.machineId : patch.machineId;
      if (patch.isActive === false || machineId != null) {
        const installed = await tx
          .select({ machineId: machineParts.machineId })
          .from(machineParts)
          .where(and(eq(machineParts.inventoryItemId, itemId), isNull(machineParts.replacedAt)));
        if (patch.isActive === false && installed.length > 0) return { ok: false, error: "in_use" };
        if (machineId != null && installed.some((p) => p.machineId !== machineId)) return { ok: false, error: "in_use" };
      }
      await tx.update(inventoryItems).set(patch).where(eq(inventoryItems.id, itemId));
      return { ok: true };
    });
  } catch (error) {
    if (uniqueViolation(error) === "inventory_items_name_key") return { ok: false, error: "duplicate" };
    throw error;
  }
}

// ---- receiveStock, consumeStock, adjustStock

export type MovementResult = { ok: true; movementId: number; balance: number } | { ok: false; error: "validation" | "not_found" };

const receiveInput = z.strictObject({ itemId: rowId, quantity, note: note.optional() });
const adjustInput = z.strictObject({
  itemId: rowId,
  quantity: z.number().int().min(-MOVE_MAX).max(MOVE_MAX).refine((q) => q !== 0),
  note, // required (§1.10)
});

async function addMovement(
  actor: Actor,
  itemId: number,
  type: "receive" | "consume" | "adjust",
  signed: number,
  movementNote: string | undefined,
): Promise<MovementResult> {
  return getDb().transaction(async (tx): Promise<MovementResult> => {
    const [item] = await tx.select({ id: inventoryItems.id }).from(inventoryItems).where(eq(inventoryItems.id, itemId));
    if (!item) return { ok: false, error: "not_found" };
    const [row] = await tx
      .insert(inventoryMovements)
      .values({ itemId, type, quantity: signed, note: movementNote ?? null, createdBy: actor.userId })
      .returning({ id: inventoryMovements.id });
    await audit(tx, actor, {
      action: `stock.${type}` as const,
      entity: "inventory_movements",
      entityId: row.id,
      details: { itemId, quantity: signed, ...(movementNote ? { note: movementNote } : {}) },
    });
    return { ok: true, movementId: row.id, balance: await itemBalance(tx, itemId) };
  });
}

/** Movement `receive` +quantity. Audited `stock.receive`. */
export async function receiveStockFor(actor: Actor, input: unknown): Promise<MovementResult> {
  requireAdmin(actor);
  const parsed = receiveInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  return addMovement(actor, parsed.data.itemId, "receive", parsed.data.quantity, parsed.data.note);
}

/** Movement `consume` −quantity, by hand (toner and master rolls when replaced). Audited `stock.consume`. */
export async function consumeStockFor(actor: Actor, input: unknown): Promise<MovementResult> {
  requireAdmin(actor);
  const parsed = receiveInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  return addMovement(actor, parsed.data.itemId, "consume", -parsed.data.quantity, parsed.data.note);
}

/** Movement `adjust` ±quantity with a required note (a count, or the correction of a mistake). Audited `stock.adjust`. */
export async function adjustStockFor(actor: Actor, input: unknown): Promise<MovementResult> {
  requireAdmin(actor);
  const parsed = adjustInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  return addMovement(actor, parsed.data.itemId, "adjust", parsed.data.quantity, parsed.data.note);
}

// ---- listMachineParts, addMachinePart, replaceMachinePart

export interface MachinePartRow {
  id: number;
  machineId: number;
  machineName: string;
  name: string;
  inventoryItemId: number | null;
  inventoryItemName: string | null;
  lifeImpressions: number;
  impressionsUsed: number;
  installedAt: Date;
  replacedAt: Date | null;
  replacedByName: string | null;
}
export type ListPartsResult = { ok: true; items: MachinePartRow[] } | { ok: false; error: "validation" };

const listPartsInput = z.strictObject({ machineId: rowId.optional(), includeReplaced: z.boolean().optional() });

/** Installed parts (and the replaced history with `includeReplaced`), by machine, newest installed first. */
export async function listMachinePartsFor(actor: Actor, input: unknown = {}): Promise<ListPartsResult> {
  requireAdmin(actor);
  const parsed = listPartsInput.safeParse(input ?? {});
  if (!parsed.success) return VALIDATION;
  const { machineId, includeReplaced } = parsed.data;
  const items = await getDb()
    .select({
      id: machineParts.id,
      machineId: machineParts.machineId,
      machineName: machines.name,
      name: machineParts.name,
      inventoryItemId: machineParts.inventoryItemId,
      inventoryItemName: inventoryItems.name,
      lifeImpressions: machineParts.lifeImpressions,
      impressionsUsed: machineParts.impressionsUsed,
      installedAt: machineParts.installedAt,
      replacedAt: machineParts.replacedAt,
      replacedByName: users.fullName,
    })
    .from(machineParts)
    .innerJoin(machines, eq(machines.id, machineParts.machineId))
    .leftJoin(inventoryItems, eq(inventoryItems.id, machineParts.inventoryItemId))
    .leftJoin(users, eq(users.id, machineParts.replacedBy))
    .where(
      and(
        machineId ? eq(machineParts.machineId, machineId) : undefined,
        includeReplaced ? undefined : isNull(machineParts.replacedAt),
      ),
    )
    .orderBy(asc(machines.name), asc(machineParts.machineId), desc(machineParts.installedAt), desc(machineParts.id));
  return { ok: true, items };
}

const addPartInput = z.strictObject({
  machineId: rowId,
  name: text(100),
  lifeImpressions: z.number().int().min(1).max(INT_MAX),
  inventoryItemId: rowId.nullable().optional(),
});

export type AddPartResult = { ok: true; part: { id: number } } | { ok: false; error: "validation" };

/**
 * A part installed now, counter at 0, on a machine that is not archived. Its stock item, if given, is an active item
 * of kind `part` on no machine or on this one (owner, 2026-11-27, step 3.1). Audited `part.add`.
 */
export async function addMachinePartFor(actor: Actor, input: unknown): Promise<AddPartResult> {
  requireAdmin(actor);
  const parsed = addPartInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const v = parsed.data;
  return getDb().transaction(async (tx): Promise<AddPartResult> => {
    const [machine] = await tx
      .select({ id: machines.id })
      .from(machines)
      .where(and(eq(machines.id, v.machineId), isNull(machines.archivedAt)))
      .for("update");
    if (!machine) return VALIDATION;
    if (v.inventoryItemId != null) {
      const [item] = await tx
        .select({ kind: inventoryItems.kind, machineId: inventoryItems.machineId, isActive: inventoryItems.isActive })
        .from(inventoryItems)
        .where(eq(inventoryItems.id, v.inventoryItemId))
        .for("share");
      if (!item || item.kind !== "part" || !item.isActive) return VALIDATION;
      if (item.machineId != null && item.machineId !== v.machineId) return VALIDATION;
    }
    const [part] = await tx
      .insert(machineParts)
      .values({
        machineId: v.machineId,
        name: v.name,
        inventoryItemId: v.inventoryItemId ?? null,
        lifeImpressions: v.lifeImpressions,
      })
      .returning({ id: machineParts.id });
    await audit(tx, actor, {
      action: "part.add",
      entity: "machine_parts",
      entityId: part.id,
      details: { machineId: v.machineId, name: v.name, lifeImpressions: v.lifeImpressions, inventoryItemId: v.inventoryItemId ?? null },
    });
    return { ok: true, part };
  });
}

const replacePartInput = z.strictObject({ partId: rowId, lifeImpressions: z.number().int().min(1).max(INT_MAX).optional() });

export type ReplacePartResult =
  | { ok: true; part: { id: number }; movementId: number | null }
  | { ok: false; error: "validation" | "not_found" | "refused" }; // refused = already replaced

/**
 * Closes the installed row (`replaced_at`, `replaced_by`) and opens a new one at 0 with the same name and stock item;
 * the life is copied unless one is given (owner, 2026-11-27, step 3.1). When the part has a stock item: movement
 * `consume −1` on it, `machine_part_id` = the new row. Guarded by `replaced_at IS NULL`, so a second replace of the same
 * row is refused. Audited `part.replace`.
 */
export async function replaceMachinePartFor(actor: Actor, input: unknown): Promise<ReplacePartResult> {
  requireAdmin(actor);
  const parsed = replacePartInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const { partId, lifeImpressions } = parsed.data;
  return getDb().transaction(async (tx): Promise<ReplacePartResult> => {
    const [found] = await tx.select({ machineId: machineParts.machineId }).from(machineParts).where(eq(machineParts.id, partId));
    if (!found) return { ok: false, error: "not_found" };
    await tx.select({ id: machines.id }).from(machines).where(eq(machines.id, found.machineId)).for("update");

    const now = new Date();
    const [old] = await tx
      .update(machineParts)
      .set({ replacedAt: now, replacedBy: actor.userId })
      .where(and(eq(machineParts.id, partId), isNull(machineParts.replacedAt)))
      .returning();
    if (!old) return { ok: false, error: "refused" };

    const life = lifeImpressions ?? old.lifeImpressions;
    const [part] = await tx
      .insert(machineParts)
      .values({ machineId: old.machineId, name: old.name, inventoryItemId: old.inventoryItemId, lifeImpressions: life, installedAt: now })
      .returning({ id: machineParts.id });

    let movementId: number | null = null;
    if (old.inventoryItemId != null) {
      const [m] = await tx
        .insert(inventoryMovements)
        .values({ itemId: old.inventoryItemId, type: "consume", quantity: -1, machinePartId: part.id, createdBy: actor.userId })
        .returning({ id: inventoryMovements.id });
      movementId = m.id;
    }
    await audit(tx, actor, {
      action: "part.replace",
      entity: "machine_parts",
      entityId: part.id,
      details: {
        machineId: old.machineId,
        name: old.name,
        oldPartId: old.id,
        oldImpressionsUsed: old.impressionsUsed,
        lifeImpressions: life,
        inventoryItemId: old.inventoryItemId,
      },
    });
    return { ok: true, part, movementId };
  });
}

// ---- T3 (markReady): paper and part counters, in the caller's transaction

/**
 * Contracts §2 T3: paper `consume −sheets` and, when wasted > 0, `waste −wastedSheets` on the active paper item
 * (`booking_id` set; the unique index makes each happen once per booking); then `impressions_used += impressions` on
 * every installed part of the machine. Never refuses: stock may go negative (§8.12). Without a paper item (only an
 * emptied test database) the paper rows are skipped.
 */
export async function recordReadyStock(
  tx: Tx,
  actor: Actor,
  job: { bookingId: number; machineId: number; sheets: number; impressions: number; wastedSheets: number },
): Promise<void> {
  const [paper] = await tx
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.kind, "paper"), eq(inventoryItems.isActive, true)));
  if (paper) {
    const rows: (typeof inventoryMovements.$inferInsert)[] = [
      { itemId: paper.id, type: "consume", quantity: -job.sheets, bookingId: job.bookingId, createdBy: actor.userId },
    ];
    if (job.wastedSheets > 0) {
      rows.push({ itemId: paper.id, type: "waste", quantity: -job.wastedSheets, bookingId: job.bookingId, createdBy: actor.userId });
    }
    await tx.insert(inventoryMovements).values(rows);
  }
  await tx.select({ id: machines.id }).from(machines).where(eq(machines.id, job.machineId)).for("key share");
  await tx
    .update(machineParts)
    .set({ impressionsUsed: sql`${machineParts.impressionsUsed} + ${job.impressions}` })
    .where(and(eq(machineParts.machineId, job.machineId), isNull(machineParts.replacedAt)));
}

// ---- getStockAlerts (§3.10)

export type StockAlertsResult = { ok: true; alerts: StockAlert[] };

/**
 * `low_stock`: an active item whose balance ≤ min_quantity. `part_near_end`: an installed part of a machine that is not
 * archived with impressions_used ≥ life × part_warn_percent / 100. `paper_short`: a date from today to
 * today + suggestion_search_days whose booked + in_progress sheets exceed the paper balance (each date alone).
 */
export async function getStockAlertsFor(actor: Actor): Promise<StockAlertsResult> {
  requireAdmin(actor);
  return { ok: true, alerts: await stockAlerts(getDb(), new Date()) };
}

export async function stockAlerts(ex: Executor, now: Date): Promise<StockAlert[]> {
  const settings = await loadSettings(ex);
  const alerts: StockAlert[] = [];

  const balance = balanceOf();
  const low = await ex
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.isActive, true), sql`${balance} <= ${inventoryItems.minQuantity}`))
    .orderBy(asc(inventoryItems.kind), asc(inventoryItems.name));
  for (const item of low) alerts.push({ kind: "low_stock", itemId: item.id });

  const worn = await ex
    .select({ id: machineParts.id })
    .from(machineParts)
    .innerJoin(machines, eq(machines.id, machineParts.machineId))
    .where(
      and(
        isNull(machineParts.replacedAt),
        isNull(machines.archivedAt),
        sql`${machineParts.impressionsUsed}::bigint * 100 >= ${machineParts.lifeImpressions}::bigint * ${settings.partWarnPercent}`,
      ),
    )
    .orderBy(asc(machines.name), asc(machineParts.name), asc(machineParts.id));
  for (const part of worn) alerts.push({ kind: "part_near_end", machinePartId: part.id });

  const [paper] = await ex
    .select({ id: inventoryItems.id, balance })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.kind, "paper"), eq(inventoryItems.isActive, true)));
  if (paper) {
    const today = localDate(now);
    const days = await ex
      .select({ date: bookings.workDate, sheets: sql<number>`sum(${bookings.sheets})`.mapWith(Number) })
      .from(bookings)
      .where(
        and(
          inArray(bookings.status, ["booked", "in_progress"]),
          gte(bookings.workDate, today),
          sql`${bookings.workDate} <= ${addDays(today, settings.suggestionSearchDays)}`,
        ),
      )
      .groupBy(bookings.workDate)
      .having(sql`sum(${bookings.sheets}) > ${paper.balance}`)
      .orderBy(asc(bookings.workDate));
    for (const d of days) if (d.date) alerts.push({ kind: "paper_short", itemId: paper.id, date: d.date });
  }
  return alerts;
}
