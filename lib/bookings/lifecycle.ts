// Booking state transitions T2, T3, T4, T7 (contracts §2). T5 / T6 (cancel) come with step 2.3.
// Each is one guarded UPDATE: `WHERE id = $1 AND status = $from AND <guards>`; zero rows = refused.
// No scheduling lock (§3.9 last bullet). The server actions in lib/actions/bookings.ts run the role guard
// and call these. Not a "use server" file: nothing here is a public endpoint.
import "server-only";
import { and, eq, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Tx } from "@/db";
import { bookings } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import { AuthError, type Actor } from "@/lib/auth/guard";
import { bookingData, notifyCollege } from "@/lib/notifications";
import { localDate } from "@/lib/scheduling/time";
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
}

/** The one UPDATE of a transition. Null = no row matched (not there, other status, or a guard failed). */
async function move(
  tx: Tx,
  bookingId: number,
  from: BookingStatus,
  to: BookingStatus,
  guards: SQL[],
  set: BookingSet,
  now: Date,
): Promise<Moved | null> {
  const [row] = await tx
    .update(bookings)
    .set({ ...set, status: to, updatedAt: now })
    .where(and(eq(bookings.id, bookingId), eq(bookings.status, from), ...guards))
    .returning({
      id: bookings.id,
      reference: bookings.reference,
      status: bookings.status,
      collegeId: bookings.collegeId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
    });
  return row ?? null;
}

/** After zero rows: "not_found" when the booking does not exist, else "refused". */
async function missed(tx: Tx, bookingId: number): Promise<TransitionResult> {
  const [found] = await tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.id, bookingId));
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
 * The paper movements and the part counters of T3 are added with the stock tables (step 3.1; owner, 2026-11-25).
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
