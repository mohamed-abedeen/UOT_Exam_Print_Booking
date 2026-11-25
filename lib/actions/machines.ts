"use server";
// Machine actions (contracts §4 "Machines and maintenance"): the list is open to operator and admin (read-only
// for the operator), the writes to the admin. Rows are never deleted; archiving sets `archived_at`.
// Step 1.5 does not touch bookings on an archived or edited machine: the reassign-or-flag step of §3.8 comes
// with the maintenance step (owner, 2026-11-25).
// Every write takes the scheduling lock first (§3.9), so a booking being placed never sees half a change.
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { machines } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import { requireRole } from "@/lib/auth/guard";
import { takeSchedulingLock } from "@/lib/scheduling/load";
import type { Machine } from "@/lib/scheduling/types";

const ADMIN = ["admin"] as const;
const OPERATOR_OR_ADMIN = ["operator", "admin"] as const;

const id = z.number().int().positive();
/** An upper bound that keeps every number inside the integer column. */
const count = (min: number) => z.number().int().min(min).max(1_000_000);

/** Same shape as the scheduling `Machine`, so an active row can go straight into `eligibleMachines()`. */
export interface MachineRow extends Machine {
  name: string;
  model: string;
  type: "laser" | "duplicator";
}

const columns = {
  id: machines.id,
  name: machines.name,
  model: machines.model,
  type: machines.type,
  minSheets: machines.minSheets,
  maxSheets: machines.maxSheets,
  supportsDuplex: machines.supportsDuplex,
  speedPerHour: machines.speedPerHour,
  setupMinutesPerModel: machines.setupMinutesPerModel,
  priority: machines.priority,
  archivedAt: machines.archivedAt,
};

export async function listMachines(): Promise<MachineRow[]> {
  await requireRole(OPERATOR_OR_ADMIN);
  return getDb().select(columns).from(machines).orderBy(asc(machines.id));
}

/** The name of the unique constraint a failed write hit, or null. Drizzle wraps the driver error in `cause`. */
function uniqueViolation(error: unknown): string | null {
  for (let e = error as { code?: string; constraint_name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === "23505") return e.constraint_name ?? "";
  }
  return null;
}

const machineFields = z
  .object({
    name: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(100),
    type: z.enum(["laser", "duplicator"]),
    minSheets: count(1), // impressions
    maxSheets: count(1).nullable(), // null = no limit
    supportsDuplex: z.boolean(),
    speedPerHour: count(1), // impressions per hour
    setupMinutesPerModel: count(0),
    priority: count(0), // lower = preferred
  })
  .refine((v) => v.maxSheets === null || v.maxSheets >= v.minSheets);

type MachineFields = z.infer<typeof machineFields>;

function fieldsOf(row: MachineFields): MachineFields {
  return {
    name: row.name,
    model: row.model,
    type: row.type,
    minSheets: row.minSheets,
    maxSheets: row.maxSheets,
    supportsDuplex: row.supportsDuplex,
    speedPerHour: row.speedPerHour,
    setupMinutesPerModel: row.setupMinutesPerModel,
    priority: row.priority,
  };
}

export type CreateMachineResult =
  | { ok: true; machine: { id: number } }
  | { ok: false; error: "validation" | "name_taken" };

export async function createMachine(input: unknown): Promise<CreateMachineResult> {
  const actor = await requireRole(ADMIN);
  const parsed = machineFields.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const v = parsed.data;

  try {
    return await getDb().transaction(async (tx): Promise<CreateMachineResult> => {
      await takeSchedulingLock(tx);
      const [machine] = await tx.insert(machines).values(v).returning({ id: machines.id });
      await audit(tx, actor, { action: "machine.create", entity: "machines", entityId: machine.id, details: { after: v } });
      return { ok: true, machine: { id: machine.id } };
    });
  } catch (e) {
    if (uniqueViolation(e) === "machines_name_key") return { ok: false, error: "name_taken" };
    throw e;
  }
}

const updateMachineInput = z.object({ machineId: id, fields: machineFields });

export type UpdateMachineResult = { ok: true } | { ok: false; error: "validation" | "not_found" | "name_taken" };

/** Replaces every editable field. Bookings already on the machine are not looked at (see the file header). */
export async function updateMachine(input: unknown): Promise<UpdateMachineResult> {
  const actor = await requireRole(ADMIN);
  const parsed = updateMachineInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const { machineId, fields } = parsed.data;

  try {
    return await getDb().transaction(async (tx): Promise<UpdateMachineResult> => {
      await takeSchedulingLock(tx);
      const [before] = await tx.select().from(machines).where(eq(machines.id, machineId)).for("update");
      if (!before) return { ok: false, error: "not_found" };
      const beforeFields = fieldsOf(before);
      if (JSON.stringify(beforeFields) === JSON.stringify(fields)) return { ok: true };
      await tx.update(machines).set({ ...fields, updatedAt: new Date() }).where(eq(machines.id, before.id));
      await audit(tx, actor, {
        action: "machine.update",
        entity: "machines",
        entityId: before.id,
        details: { before: beforeFields, after: fields },
      });
      return { ok: true };
    });
  } catch (e) {
    if (uniqueViolation(e) === "machines_name_key") return { ok: false, error: "name_taken" };
    throw e;
  }
}

const machineIdInput = z.object({ machineId: id });

export type SetArchivedResult = { ok: true } | { ok: false; error: "validation" | "not_found" | "name_taken" };

async function setArchived(input: unknown, archived: boolean): Promise<SetArchivedResult> {
  const actor = await requireRole(ADMIN);
  const parsed = machineIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const { machineId } = parsed.data;

  try {
    return await getDb().transaction(async (tx): Promise<SetArchivedResult> => {
      await takeSchedulingLock(tx);
      const [before] = await tx.select().from(machines).where(eq(machines.id, machineId)).for("update");
      if (!before) return { ok: false, error: "not_found" };
      if ((before.archivedAt !== null) === archived) return { ok: true };
      const now = new Date();
      await tx
        .update(machines)
        .set({ archivedAt: archived ? now : null, updatedAt: now })
        .where(eq(machines.id, before.id));
      await audit(tx, actor, {
        action: archived ? "machine.archive" : "machine.unarchive",
        entity: "machines",
        entityId: before.id,
        details: { name: before.name },
      });
      return { ok: true };
    });
  } catch (e) {
    // unarchiving a name that an active machine already uses
    if (uniqueViolation(e) === "machines_name_key") return { ok: false, error: "name_taken" };
    throw e;
  }
}

export async function archiveMachine(input: unknown): Promise<SetArchivedResult> {
  return setArchived(input, true);
}

export async function unarchiveMachine(input: unknown): Promise<SetArchivedResult> {
  return setArchived(input, false);
}
