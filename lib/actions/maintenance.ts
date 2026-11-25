"use server";
// Maintenance actions (contracts §4 "Machines and maintenance"), admin only. Every export of this file is a public
// endpoint: the role guard is the first line of each one; the work is in lib/maintenance/.
import { requireRole } from "@/lib/auth/guard";
import {
  endMaintenanceFor,
  listMaintenanceFor,
  startMaintenanceFor,
  type EndMaintenanceResult,
  type ListMaintenanceResult,
  type StartMaintenanceResult,
} from "@/lib/maintenance";

const ADMIN = ["admin"] as const;

/**
 * §3.8 `{ machineId, startsAt?, endsAt, reason }`: no `startsAt` = stop now; `endsAt` null = until reactivated.
 * Returns the bookings it moved to another machine and the ones it flagged.
 */
export async function startMaintenance(input: unknown): Promise<StartMaintenanceResult> {
  const actor = await requireRole(ADMIN);
  return startMaintenanceFor(actor, input);
}

/** §3.8 `{ maintenanceId }`: reactivate now, or cancel a window that has not started. Returns the restored bookings. */
export async function endMaintenance(input: unknown): Promise<EndMaintenanceResult> {
  const actor = await requireRole(ADMIN);
  return endMaintenanceFor(actor, input);
}

/** The maintenance log, newest start first; `{ machineId }` for one machine. */
export async function listMaintenance(input?: unknown): Promise<ListMaintenanceResult> {
  await requireRole(ADMIN);
  return listMaintenanceFor(input);
}
