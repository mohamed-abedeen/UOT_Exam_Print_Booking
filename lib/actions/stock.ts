"use server";
// Stock actions (contracts §4 "Stock"). Every export of this file is a public endpoint: the role guard is the first
// line of each one; the work is in lib/stock/. Operators do not see stock (§8.15).
import { requireRole } from "@/lib/auth/guard";
import {
  addMachinePartFor,
  adjustStockFor,
  consumeStockFor,
  createInventoryItemFor,
  getStockAlertsFor,
  listInventoryFor,
  listMachinePartsFor,
  listMovementsFor,
  receiveStockFor,
  replaceMachinePartFor,
  updateInventoryItemFor,
  type AddPartResult,
  type CreateItemResult,
  type ListInventoryResult,
  type ListMovementsResult,
  type ListPartsResult,
  type MovementResult,
  type ReplacePartResult,
  type StockAlertsResult,
  type UpdateItemResult,
} from "@/lib/stock";

/** Admin only: every item with its balance (sum of movements). */
export async function listInventory(): Promise<ListInventoryResult> {
  const actor = await requireRole(["admin"]);
  return listInventoryFor(actor);
}

/** Admin only: `{ itemId?, from?, to? }`, newest first, at most 500 rows. */
export async function listMovements(input?: unknown): Promise<ListMovementsResult> {
  const actor = await requireRole(["admin"]);
  return listMovementsFor(actor, input);
}

/** Admin only: low stock, parts near the end of their life, days short of paper. */
export async function getStockAlerts(): Promise<StockAlertsResult> {
  const actor = await requireRole(["admin"]);
  return getStockAlertsFor(actor);
}

/** Admin only: `{ name, kind (toner | master_roll | part), unit, machineId?, minQuantity? }`. */
export async function createInventoryItem(input: unknown): Promise<CreateItemResult> {
  const actor = await requireRole(["admin"]);
  return createInventoryItemFor(actor, input);
}

/** Admin only: `{ itemId, name?, unit?, machineId?, minQuantity?, isActive? }`; kind never changes. */
export async function updateInventoryItem(input: unknown): Promise<UpdateItemResult> {
  const actor = await requireRole(["admin"]);
  return updateInventoryItemFor(actor, input);
}

/** Admin only: `{ itemId, quantity, note? }`, movement `receive` (+). */
export async function receiveStock(input: unknown): Promise<MovementResult> {
  const actor = await requireRole(["admin"]);
  return receiveStockFor(actor, input);
}

/** Admin only: `{ itemId, quantity, note? }`, movement `consume` (−); toner and master rolls by hand. */
export async function consumeStock(input: unknown): Promise<MovementResult> {
  const actor = await requireRole(["admin"]);
  return consumeStockFor(actor, input);
}

/** Admin only: `{ itemId, quantity (±), note }`, movement `adjust`. */
export async function adjustStock(input: unknown): Promise<MovementResult> {
  const actor = await requireRole(["admin"]);
  return adjustStockFor(actor, input);
}

/** Admin only: `{ machineId?, includeReplaced? }`. */
export async function listMachineParts(input?: unknown): Promise<ListPartsResult> {
  const actor = await requireRole(["admin"]);
  return listMachinePartsFor(actor, input);
}

/** Admin only: `{ machineId, name, lifeImpressions, inventoryItemId? }`. */
export async function addMachinePart(input: unknown): Promise<AddPartResult> {
  const actor = await requireRole(["admin"]);
  return addMachinePartFor(actor, input);
}

/** Admin only: `{ partId, lifeImpressions? }`; new row at 0, `consume −1` when the part has a stock item. */
export async function replaceMachinePart(input: unknown): Promise<ReplacePartResult> {
  const actor = await requireRole(["admin"]);
  return replaceMachinePartFor(actor, input);
}
