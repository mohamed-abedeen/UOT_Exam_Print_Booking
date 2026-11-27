// Booking state transitions T2–T7 (contracts §2).
// Each is one guarded UPDATE: `WHERE id = $1 AND status = $from AND <guards>`; zero rows = refused.
// No scheduling lock (§3.9 last bullet). The server actions in lib/actions/bookings.ts run the role guard
// and call these. Not a "use server" file: nothing here is a public endpoint.
import "server-only";
import { and, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Tx } from "@/db";
import { bookings } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import { AuthError, ownRows, type Actor } from "@/lib/auth/guard";
import { bookingData, notifyCollege } from "@/lib/notifications";
import { loadSettings } from "@/lib/scheduling/load";
import { addMinutes, localDate } from "@/lib/scheduling/time";
import { recordReadyStock } from "@/lib/stock";
import type { BookingStatus } from "@/lib/scheduling/types";

export type TransitionResult =
  | { ok: true; booking: { id: number; reference: string; status: BookingStatus } }
  | { ok: false; error: "validation" | "not_found" | "refused" };

const VALIDATION = { ok: false, error: "validation" } as const;
const INT_MAX = 2_147_483_647; // `integer` column

const id = z.number().int().positive();
const bookingInput = z.strictObject({ bookingId: id });
const markReadyInput = z.strictObject({
  bookingId: id,
  wastedSheets: z.number().int().min(0).max(INT_MAX),
  wasteDestroyed: z.literal(true), // the destroyed tick is required (T3)
});
const cancelInput = z.strictObject({
  bookingId: id,
  // Optional for T5, required for T6. Blank = none given.
  reason: z
    .string()
    .trim()
    .max(500)
    .refine((s) => !s.includes("\u0000")) // PostgreSQL text cannot hold it
    .optional(),
});

/** Every transition here is operator or admin only (contracts §4); the action's guard already said so. */
function requireStaff(actor: Actor): void {
  if (actor.role !== "operator" && actor.role !== "admin") throw new AuthError();
}

type BookingSet = Partial<typeof bookings.$inferInsert>;
const FLAG_CLEARED = { needsReschedule: false, rescheduleReason: null } satisfies BookingSet;

interface Moved {
  id: number;
  reference: string;
  status: BookingStatus;
  collegeId: number;
  startsAt: Date;
  endsAt: Date;
  machineId: number;
  sheets: number | null; // generated columns: always set on a real row
  impressions: number | null;
}

/** The one UPDATE of a transition. Null = no row matched (not there, other status, or a guard failed). */
async function move(
  tx: Tx,
  bookingId: number,
  from: BookingStatus | BookingStatus[],
  to: BookingStatus,
  guards: (SQL | undefined)[],
  set: BookingSet,
  now: Date,
): Promise<Moved | null> {
  const fromStatus = Array.isArray(from) ? inArray(bookings.status, from) : eq(bookings.status, from);
  const [row] = await tx
    .update(bookings)
    .set({ ...set, status: to, updatedAt: now })
    .where(and(eq(bookings.id, bookingId), fromStatus, ...guards))
    .returning({
      id: bookings.id,
      reference: bookings.reference,
      status: bookings.status,
      collegeId: bookings.collegeId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      machineId: bookings.machineId,
      sheets: bookings.sheets,
      impressions: bookings.impressions,
    });
  return row ?? null;
}

/** After zero rows: "not_found" when the booking does not exist (for a college: is not its own), else "refused". */
async function missed(tx: Tx, bookingId: number, own?: SQL): Promise<TransitionResult> {
  const [found] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), own));
  return { ok: false, error: found ? "refused" : "not_found" };
}

function done(row: Moved): TransitionResult {
  return { ok: true, booking: { id: row.id, reference: row.reference, status: row.status } };
}

/** T2 booked → in_progress: only on its own work date, and not while flagged for rescheduling. */
export async function confirmIdentityFor(actor: Actor, input: unknown): Promise<TransitionResult> {
  requireStaff(actor);
  const parsed = bookingInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const { bookingId } = parsed.data;
  return getDb().transaction(async (tx) => {
    const now = new Date();
    const row = await move(
      tx,
      bookingId,
      "booked",
      "in_progress",
      [eq(bookings.needsReschedule, false), eq(bookings.workDate, localDate(now))],
      { identityConfirmedBy: actor.userId, identityConfirmedAt: now },
      now,
    );
    if (!row) return missed(tx, bookingId);
    await audit(tx, actor, {
      action: "booking.confirm_identity",
      entity: "bookings",
      entityId: row.id,
      collegeId: row.collegeId,
      details: { reference: row.reference },
    });
    return done(row);
  });
}

/**
 * T3 in_progress → ready: wasted sheets given, destroyed ticked; a reschedule flag does not block it and is cleared.
 * Same transaction: paper `consume −sheets` (and `waste −wasted` when > 0), part counters += impressions (step 3.1).
 */
export async function markReadyFor(actor: Actor, input: unknown): Promise<TransitionResult> {
  requireStaff(actor);
  const parsed = markReadyInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const { bookingId, wastedSheets } = parsed.data;
  return getDb().transaction(async (tx) => {
    const now = new Date();
    const row = await move(
      tx,
      bookingId,
      "in_progress",
      "ready",
      [],
      { wastedSheets, wasteDestroyed: true, readyBy: actor.userId, readyAt: now, ...FLAG_CLEARED },
      now,
    );
    if (!row) return missed(tx, bookingId);
    await recordReadyStock(tx, actor, {
      bookingId: row.id,
      machineId: row.machineId,
      sheets: row.sheets ?? 0,
      impressions: row.impressions ?? 0,
      wastedSheets,
    });
    await notifyCollege(tx, row.collegeId, "booking_ready", row.id, bookingData(row));
    return done(row);
  });
}

/** T4 ready → delivered. */
export async function markDeliveredFor(actor: Actor, input: unknown): Promise<TransitionResult> {
  requireStaff(actor);
  const parsed = bookingInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const { bookingId } = parsed.data;
  return getDb().transaction(async (tx) => {
    const now = new Date();
    const row = await move(tx, bookingId, "ready", "delivered", [], { deliveredBy: actor.userId, deliveredAt: now }, now);
    return row ? done(row) : missed(tx, bookingId);
  });
}

/** T7 booked → no_show: once the start has come. Releases the interval (the row leaves `bookings_no_overlap`). */
export async function markNoShowFor(actor: Actor, input: unknown): Promise<TransitionResult> {
  requireStaff(actor);
  const parsed = bookingInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const { bookingId } = parsed.data;
  return getDb().transaction(async (tx) => {
    const now = new Date();
    const row = await move(
      tx,
      bookingId,
      "booked",
      "no_show",
      [lte(bookings.startsAt, now)],
      { noShowBy: actor.userId, noShowAt: now, ...FLAG_CLEARED },
      now,
    );
    if (!row) return missed(tx, bookingId);
    await audit(tx, actor, {
      action: "booking.no_show",
      entity: "bookings",
      entityId: row.id,
      collegeId: row.collegeId,
      details: { reference: row.reference },
    });
    await notifyCollege(tx, row.collegeId, "booking_no_show", row.id, bookingData(row));
    return done(row);
  });
}

/**
 * T5 booked → cancelled: a college its own booking, until `edit_deadline_minutes` before the start; an admin any
 * time. T6 in_progress → cancelled: admin only, with a reason. Releases the interval (the row leaves
 * `bookings_no_overlap`); no stock movement. An admin cancel is audited and the college is told.
 */
export async function cancelBookingFor(actor: Actor, input: unknown): Promise<TransitionResult> {
  if (actor.role !== "college" && actor.role !== "admin") throw new AuthError();
  const parsed = cancelInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const { bookingId } = parsed.data;
  const reason = parsed.data.reason || null;
  const own = ownRows(actor, bookings.collegeId);
  return getDb().transaction(async (tx) => {
    const now = new Date();
    const set = { cancelledBy: actor.userId, cancelledAt: now, cancelReason: reason, ...FLAG_CLEARED };
    let row: Moved | null;
    if (actor.role === "college") {
      const { editDeadlineMinutes } = await loadSettings(tx);
      const deadline = gte(bookings.startsAt, addMinutes(now, editDeadlineMinutes)); // now <= starts_at − deadline
      row = await move(tx, bookingId, "booked", "cancelled", [own, deadline], set, now);
    } else {
      row = await move(tx, bookingId, reason ? ["booked", "in_progress"] : "booked", "cancelled", [], set, now);
    }
    if (!row) return missed(tx, bookingId, own);
    if (actor.role === "admin") {
      await audit(tx, actor, {
        action: "booking.admin_cancel",
        entity: "bookings",
        entityId: row.id,
        collegeId: row.collegeId,
        details: { reference: row.reference, reason },
      });
      await notifyCollege(tx, row.collegeId, "booking_cancelled", row.id, bookingData(row));
    }
    return done(row);
  });
}
