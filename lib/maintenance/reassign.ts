// Reassign or flag (contracts §3.8): the bookings that a maintenance stop, an archive or a machine edit leaves
// unusable on their machine. Runs inside the caller's transaction, after the scheduling lock and after the change
// that made them unusable is written, so `ctx` already sees it. Not a "use server" file.
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { bookings } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import type { Actor } from "@/lib/auth/guard";
import { bookingData, notifyAdmins, notifyCollege } from "@/lib/notifications";
import { loadContext } from "@/lib/scheduling/load";
import { reassignSameTime } from "@/lib/scheduling/schedule";

export interface TouchedBooking {
  id: number;
  reference: string;
}

/** What a stop, an archive or an edit did to the bookings on that machine (owner, 2026-11-25, step 2.4). */
export interface ReassignOutcome {
  moved: TouchedBooking[]; // same start, another machine
  flagged: TouchedBooking[]; // no machine at that time: in the admin list (also the ones flagged before)
}

type Holding = "booked" | "in_progress";

/**
 * Each booking in turn (the caller passes them in `starts_at` order): another machine at the same start
 * (`reassignSameTime`), else the flag. `ctx` is loaded again for every booking, so the earlier moves count.
 * A booking already flagged keeps its reason (for example `delay_no_slot`) and gets an audit row only. A booking
 * that left `statuses` meanwhile (a transition takes no lock) is skipped.
 */
export async function reassignOrFlag(
  tx: Tx,
  actor: Actor,
  bookingIds: number[],
  reason: "maintenance" | "machine_change",
  statuses: Holding[],
  now: Date,
): Promise<ReassignOutcome> {
  const out: ReassignOutcome = { moved: [], flagged: [] };
  for (const bookingId of bookingIds) {
    const holding = and(eq(bookings.id, bookingId), inArray(bookings.status, statuses));
    const [b] = await tx
      .select({
        id: bookings.id,
        reference: bookings.reference,
        collegeId: bookings.collegeId,
        machineId: bookings.machineId,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        models: bookings.models,
        pagesPerModel: bookings.pagesPerModel,
        copies: bookings.copies,
        sides: bookings.sides,
        needsReschedule: bookings.needsReschedule,
        rescheduleReason: bookings.rescheduleReason,
      })
      .from(bookings)
      .where(holding);
    if (!b) continue;
    const from = { machineId: b.machineId, startsAt: b.startsAt, endsAt: b.endsAt };
    const touched = { id: b.id, reference: b.reference };

    const ctx = await loadContext(tx, { now, collegeId: b.collegeId, ignoreBookingId: b.id });
    const target = reassignSameTime(b, ctx);
    if (target) {
      // The start stays; the college is not told (contracts §8.7). A flag set before stays as it is.
      const [row] = await tx
        .update(bookings)
        .set({ machineId: target.machineId, endsAt: target.endsAt, updatedAt: now })
        .where(holding)
        .returning({ id: bookings.id });
      if (!row) continue;
      await audit(tx, actor, {
        action: "booking.auto_move",
        entity: "bookings",
        entityId: b.id,
        collegeId: b.collegeId,
        details: { reference: b.reference, cause: reason, from, to: target },
      });
      out.moved.push(touched);
      continue;
    }

    if (b.needsReschedule) {
      await audit(tx, actor, {
        action: "booking.flag_reschedule",
        entity: "bookings",
        entityId: b.id,
        collegeId: b.collegeId,
        details: { reference: b.reference, cause: reason, kept: b.rescheduleReason },
      });
      out.flagged.push(touched);
      continue;
    }

    const [row] = await tx
      .update(bookings)
      .set({ needsReschedule: true, rescheduleReason: reason, updatedAt: now })
      .where(and(holding, eq(bookings.needsReschedule, false)))
      .returning({ id: bookings.id, reference: bookings.reference, startsAt: bookings.startsAt, endsAt: bookings.endsAt });
    if (!row) continue;
    await audit(tx, actor, {
      action: "booking.flag_reschedule",
      entity: "bookings",
      entityId: b.id,
      collegeId: b.collegeId,
      details: { reference: b.reference, cause: reason },
    });
    await notifyCollege(tx, b.collegeId, "booking_needs_reschedule", b.id, bookingData(row));
    await notifyAdmins(tx, "booking_needs_reschedule", b.id, bookingData(row));
    out.flagged.push(touched);
  }
  return out;
}
