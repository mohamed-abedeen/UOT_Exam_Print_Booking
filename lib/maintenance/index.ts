// Maintenance stops (contracts §1.5, §3.8): stop now or a planned window, reactivate, the log. Both writes take the
// scheduling lock (§3.9). The server actions in lib/actions/maintenance.ts run the role guard (admin) and call
// these. Not a "use server" file.
import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { getDb, type Tx } from "@/db";
import { bookings, machineMaintenance, machines, users } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import { AuthError, type Actor } from "@/lib/auth/guard";
import { isPlacementConflict, MAX_RETRIES, VALIDATION } from "@/lib/bookings/create";
import { bookingData, notifyCollege } from "@/lib/notifications";
import { takeSchedulingLock } from "@/lib/scheduling/load";
import { isStaticEligible } from "@/lib/scheduling/schedule";
import { reassignOrFlag, type ReassignOutcome, type TouchedBooking } from "./reassign";

const id = z.number().int().positive();
// The bounds keep date arithmetic inside the range of Date.
const instant = z.date().min(new Date(0)).max(new Date("9999-12-31T00:00:00Z"));
const reason = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((s) => !s.includes("\u0000")); // PostgreSQL text cannot hold it

// No `startsAt` = stop now (the server's clock after the lock). Free instants, not the 10-minute grid (owner,
// 2026-11-25, step 2.4).
const startInput = z.strictObject({
  machineId: id,
  startsAt: instant.optional(),
  endsAt: instant.nullable(),
  reason,
});
const endInput = z.strictObject({ maintenanceId: id });
const listInput = z.strictObject({ machineId: id.optional() });

export type StartMaintenanceResult =
  | ({ ok: true; maintenance: { id: number } } & ReassignOutcome)
  | { ok: false; error: "validation" | "not_found" | "overlaps" };

export type EndMaintenanceResult =
  | { ok: true; restored: TouchedBooking[] }
  | { ok: false; error: "validation" | "not_found" | "refused" };

/** Rows of the machine that block [start, end) (end null = open): a cancelled window (empty range) never does. */
function overlapping(machineId: number, start: Date, end: Date | null) {
  return and(
    eq(machineMaintenance.machineId, machineId),
    or(
      isNull(machineMaintenance.endsAt),
      and(gt(machineMaintenance.endsAt, machineMaintenance.startsAt), gt(machineMaintenance.endsAt, start)),
    ),
    end === null ? undefined : lt(machineMaintenance.startsAt, end),
  );
}

// ---- startMaintenance

type StartInput = z.infer<typeof startInput>;

function tryStart(actor: Actor, v: StartInput): Promise<StartMaintenanceResult> {
  return getDb().transaction(async (tx: Tx): Promise<StartMaintenanceResult> => {
    await takeSchedulingLock(tx);
    const now = new Date(); // after the wait for the lock, never before
    // A planned window starts in the future; the end, when given, lies after the start.
    if (v.startsAt !== undefined && v.startsAt.getTime() <= now.getTime()) return VALIDATION;
    const start = v.startsAt ?? now;
    if (v.endsAt !== null && v.endsAt.getTime() <= start.getTime()) return VALIDATION;

    const [machine] = await tx
      .select({ id: machines.id, name: machines.name, archivedAt: machines.archivedAt })
      .from(machines)
      .where(eq(machines.id, v.machineId));
    if (!machine || machine.archivedAt !== null) return { ok: false, error: "not_found" };

    // Checked here so the answer is a result, not a `maintenance_no_overlap` exception.
    const [clash] = await tx
      .select({ id: machineMaintenance.id })
      .from(machineMaintenance)
      .where(overlapping(machine.id, start, v.endsAt))
      .limit(1);
    if (clash) return { ok: false, error: "overlaps" };

    const [row] = await tx
      .insert(machineMaintenance)
      .values({ machineId: machine.id, startsAt: start, endsAt: v.endsAt, reason: v.reason, createdBy: actor.userId })
      .returning({ id: machineMaintenance.id });
    await audit(tx, actor, {
      action: "maintenance.start",
      entity: "machine_maintenance",
      entityId: row.id,
      details: { machineId: machine.id, machine: machine.name, startsAt: start, endsAt: v.endsAt, reason: v.reason },
    });

    // Every holding booking on the machine whose interval overlaps the window, also when the window starts later:
    // from now on the window is busy time.
    const affected = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.machineId, machine.id),
          inArray(bookings.status, ["booked", "in_progress"]),
          gt(bookings.endsAt, start),
          v.endsAt === null ? undefined : lt(bookings.startsAt, v.endsAt),
        ),
      )
      .orderBy(asc(bookings.startsAt), asc(bookings.id));
    const outcome = await reassignOrFlag(
      tx,
      actor,
      affected.map((b) => b.id),
      "maintenance",
      ["booked", "in_progress"],
      now,
    );
    return { ok: true, maintenance: { id: row.id }, ...outcome };
  });
}

/**
 * Stop a machine now (no `startsAt`) or for a planned window; `endsAt` null = until reactivated. The bookings on
 * it that overlap the window move to another machine at the same start, or are flagged `maintenance`.
 */
export async function startMaintenanceFor(actor: Actor, input: unknown): Promise<StartMaintenanceResult> {
  if (actor.role !== "admin") throw new AuthError();
  const parsed = startInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  for (let attempt = 0; ; attempt++) {
    try {
      return await tryStart(actor, parsed.data);
    } catch (error) {
      if (!isPlacementConflict(error) || attempt === MAX_RETRIES) throw error;
    }
  }
}

// ---- endMaintenance

/**
 * Reactivate: `ends_at` = now (a window that has not started is cancelled: `ends_at = starts_at`). Then every
 * booking still on the machine flagged `maintenance`, starting after now, with no stop left over its interval and
 * a machine that still takes the job, is restored (flag cleared, `booking_restored` to the college). A row that has
 * already ended is refused.
 */
export async function endMaintenanceFor(actor: Actor, input: unknown): Promise<EndMaintenanceResult> {
  if (actor.role !== "admin") throw new AuthError();
  const parsed = endInput.safeParse(input);
  if (!parsed.success) return VALIDATION;

  return getDb().transaction(async (tx): Promise<EndMaintenanceResult> => {
    await takeSchedulingLock(tx);
    const now = new Date();
    const [m] = await tx
      .select()
      .from(machineMaintenance)
      .where(eq(machineMaintenance.id, parsed.data.maintenanceId))
      .for("update");
    if (!m) return { ok: false, error: "not_found" };
    if (m.endedAt !== null || (m.endsAt !== null && m.endsAt.getTime() <= now.getTime())) {
      return { ok: false, error: "refused" };
    }

    const endsAt = m.startsAt.getTime() > now.getTime() ? m.startsAt : now;
    await tx
      .update(machineMaintenance)
      .set({ endsAt, endedBy: actor.userId, endedAt: now })
      .where(eq(machineMaintenance.id, m.id));

    const [machine] = await tx.select().from(machines).where(eq(machines.id, m.machineId));
    const stops = await tx
      .select({ startsAt: machineMaintenance.startsAt, endsAt: machineMaintenance.endsAt })
      .from(machineMaintenance)
      .where(overlapping(m.machineId, now, null));
    const holding = inArray(bookings.status, ["booked", "in_progress"]);
    const flagged = await tx
      .select({
        id: bookings.id,
        reference: bookings.reference,
        collegeId: bookings.collegeId,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        models: bookings.models,
        pagesPerModel: bookings.pagesPerModel,
        copies: bookings.copies,
        sides: bookings.sides,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.machineId, m.machineId),
          eq(bookings.rescheduleReason, "maintenance"),
          gt(bookings.startsAt, now),
          holding,
        ),
      )
      .orderBy(asc(bookings.startsAt), asc(bookings.id));

    const restored: TouchedBooking[] = [];
    for (const b of flagged) {
      const stillStopped = stops.some(
        (s) => s.startsAt.getTime() < b.endsAt.getTime() && (s.endsAt === null || s.endsAt.getTime() > b.startsAt.getTime()),
      );
      if (stillStopped || !isStaticEligible(b, machine)) continue;
      const [row] = await tx
        .update(bookings)
        .set({ needsReschedule: false, rescheduleReason: null, updatedAt: now })
        .where(and(eq(bookings.id, b.id), eq(bookings.rescheduleReason, "maintenance"), holding))
        .returning({ id: bookings.id });
      if (!row) continue;
      await notifyCollege(tx, b.collegeId, "booking_restored", b.id, bookingData(b));
      restored.push({ id: b.id, reference: b.reference });
    }

    await audit(tx, actor, {
      action: "maintenance.end",
      entity: "machine_maintenance",
      entityId: m.id,
      details: { machineId: m.machineId, startsAt: m.startsAt, endsAt: { from: m.endsAt, to: endsAt }, restored },
    });
    return { ok: true, restored };
  });
}

// ---- listMaintenance: the log (who, when, why, how long)

export interface MaintenanceItem {
  id: number;
  machineId: number;
  machineName: string;
  startsAt: Date;
  endsAt: Date | null; // null = open until reactivated
  reason: string;
  createdByName: string;
  endedByName: string | null;
  endedAt: Date | null;
  minutes: number | null; // ends_at − starts_at; null while open
}

export type ListMaintenanceResult = { ok: true; items: MaintenanceItem[] } | { ok: false; error: "validation" };

/** Every row, newest start first; `{ machineId }` for one machine. No paging (owner, 2026-11-25, step 2.4). */
export async function listMaintenanceFor(input: unknown = {}): Promise<ListMaintenanceResult> {
  const parsed = listInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const creator = alias(users, "creator");
  const ender = alias(users, "ender");
  const rows = await getDb()
    .select({
      id: machineMaintenance.id,
      machineId: machineMaintenance.machineId,
      machineName: machines.name,
      startsAt: machineMaintenance.startsAt,
      endsAt: machineMaintenance.endsAt,
      reason: machineMaintenance.reason,
      createdByName: creator.fullName,
      endedByName: ender.fullName,
      endedAt: machineMaintenance.endedAt,
    })
    .from(machineMaintenance)
    .innerJoin(machines, eq(machines.id, machineMaintenance.machineId))
    .innerJoin(creator, eq(creator.id, machineMaintenance.createdBy))
    .leftJoin(ender, eq(ender.id, machineMaintenance.endedBy))
    .where(parsed.data.machineId === undefined ? undefined : eq(machineMaintenance.machineId, parsed.data.machineId))
    .orderBy(desc(machineMaintenance.startsAt), desc(machineMaintenance.id));
  return {
    ok: true,
    items: rows.map((r) => ({
      ...r,
      minutes: r.endsAt === null ? null : Math.round((r.endsAt.getTime() - r.startsAt.getTime()) / 60_000),
    })),
  };
}
