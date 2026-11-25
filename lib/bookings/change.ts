// Changes that keep the status (contracts §3.7): editBooking, sendDelayNotice and moveBooking. Each may change a
// placement, so each try takes the scheduling lock, loads `ctx` without the booking itself (`ignoreBookingId`), decides and
// writes; a placement conflict rolls the try back and it starts again (§3.9). The UPDATE repeats every guard,
// because a state transition (no lock) may move the booking meanwhile. The server actions in
// lib/actions/bookings.ts run the role guard and call these. Not a "use server" file.
import "server-only";
import { and, eq, gte, inArray, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Tx } from "@/db";
import { bookings } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import { AuthError, ownRows, type Actor } from "@/lib/auth/guard";
import { bookingData, notifyAdmins, notifyCollege } from "@/lib/notifications";
import { availabilityFor, checkAccepted, checkMove, type Availability, type MoveRefusal } from "@/lib/scheduling/availability";
import { examDateWarning, normalizePhone } from "@/lib/scheduling/helpers";
import { loadContext, loadSettings, takeSchedulingLock } from "@/lib/scheduling/load";
import { latestFreeStart } from "@/lib/scheduling/schedule";
import { addMinutes, atMinutes, localDate, SLOT_MINUTES } from "@/lib/scheduling/time";
import type { BookingStatus, Placement, Sides } from "@/lib/scheduling/types";
import {
  acceptInput,
  formFields,
  isPlacementConflict,
  jobFields,
  jobOf,
  MAX_RETRIES,
  readAvailability,
  requestedSlot,
  VALIDATION,
} from "./create";

export type EditBookingResult =
  | { ok: true; booking: { id: number; reference: string }; examDateWarning: boolean } // same reference kept
  | {
      ok: false;
      // 'not_found' = no such booking, or (a college) not its own; 'not_editable' = status or deadline
      error: "validation" | "not_found" | "slot_taken" | "needs_confirmation" | "refused" | "not_editable";
      availability?: Availability;
    };

export type SendDelayNoticeResult =
  | { ok: true; booking: { id: number; reference: string; startsAt: Date; endsAt: Date }; moved: boolean }
  | { ok: false; error: "validation" | "not_found" | "refused" | "slot_taken" };

export type MoveBookingResult =
  | { ok: true; booking: { id: number; reference: string; machineId: number; startsAt: Date; endsAt: Date } }
  | { ok: false; error: "validation" | "not_found" | "refused" } // 'refused' = not booked / in_progress
  | { ok: false; error: "slot_taken"; reason: MoveRefusal }; // the target fails a rule (owner, 2026-11-25, step 2.4)

/** For tests only: runs under the lock, right before the UPDATE that writes a new placement, on try `attempt`. */
export interface ChangeHooks {
  beforePlacementUpdate?(placement: Placement, attempt: number): Promise<void>;
}

const id = z.number().int().positive();
// Strict: a `collegeId` or any other unknown key is refused, not ignored (the college is the booking's).
const editBookingInput = z.strictObject({
  bookingId: id,
  ...jobFields,
  ...requestedSlot,
  ...formFields,
  accept: acceptInput.optional(),
});
const delayInput = z.strictObject({ bookingId: id });
const moveInput = z.strictObject({
  bookingId: id,
  machineId: id,
  // On the 10-minute grid; the bounds keep date arithmetic inside the range of Date.
  startsAt: z
    .date()
    .min(new Date(0))
    .max(new Date("9999-12-31T00:00:00Z"))
    .refine((d) => d.getTime() % (SLOT_MINUTES * 60_000) === 0),
});

const NOT_FOUND = { ok: false, error: "not_found" } as const;
const NOT_EDITABLE = { ok: false, error: "not_editable" } as const;
const REFUSED = { ok: false, error: "refused" } as const;
const FLAG_CLEARED = { needsReschedule: false, rescheduleReason: null } as const;

interface Current {
  id: number;
  reference: string;
  collegeId: number;
  status: BookingStatus;
  machineId: number;
  startsAt: Date;
  endsAt: Date;
  models: number;
  pagesPerModel: number;
  copies: number;
  sides: Sides;
  needsReschedule: boolean;
  delayNoticeAt: Date | null;
}

/** The booking as it is now; a college sees only its own (another college's is "not found"). */
async function currentBooking(tx: Tx, actor: Actor, bookingId: number): Promise<Current | null> {
  const [row] = await tx
    .select({
      id: bookings.id,
      reference: bookings.reference,
      collegeId: bookings.collegeId,
      status: bookings.status,
      machineId: bookings.machineId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      models: bookings.models,
      pagesPerModel: bookings.pagesPerModel,
      copies: bookings.copies,
      sides: bookings.sides,
      needsReschedule: bookings.needsReschedule,
      delayNoticeAt: bookings.delayNoticeAt,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), ownRows(actor, bookings.collegeId)));
  return row ?? null;
}

/** `now <= starts_at − minutes`, as a WHERE guard on the row's current start. */
function startsAtLeast(now: Date, minutes: number): SQL {
  return gte(bookings.startsAt, addMinutes(now, minutes));
}

// ---- editBooking

type EditInput = z.infer<typeof editBookingInput>;

/** Same job and the current start lies in the requested hour: nothing to place again. */
function keepsPlacement(b: Current, v: EditInput): boolean {
  const hourStart = atMinutes(v.date, v.hour * 60).getTime();
  const start = b.startsAt.getTime();
  return (
    b.models === v.models &&
    b.pagesPerModel === v.pagesPerModel &&
    b.copies === v.copies &&
    b.sides === v.sides &&
    start >= hourStart &&
    start < hourStart + 60 * 60_000
  );
}

/** One try. `seen.collegeId` is set once the booking is found, for the fresh availability after the last retry. */
function tryEdit(
  actor: Actor,
  v: EditInput,
  phone: string,
  attempt: number,
  hooks: ChangeHooks,
  seen: { collegeId?: number },
): Promise<EditBookingResult> {
  return getDb().transaction(async (tx): Promise<EditBookingResult> => {
    await takeSchedulingLock(tx);
    const now = new Date(); // after the wait for the lock, never before
    const b = await currentBooking(tx, actor, v.bookingId);
    if (!b) return NOT_FOUND;
    seen.collegeId = b.collegeId;

    // College: `booked` and until edit_deadline_minutes before the start. Admin: `booked`, any time.
    const guards: SQL[] = [eq(bookings.status, "booked")];
    if (actor.role === "college") {
      const { editDeadlineMinutes } = await loadSettings(tx);
      if (b.startsAt.getTime() < addMinutes(now, editDeadlineMinutes).getTime()) return NOT_EDITABLE;
      guards.push(startsAtLeast(now, editDeadlineMinutes));
    }
    if (b.status !== "booked") return NOT_EDITABLE;

    const spec = jobOf(v);
    let placement: Placement | null = null;
    if (!keepsPlacement(b, v)) {
      // Placed again exactly like a new booking, without itself in the context.
      const ctx = await loadContext(tx, { now, collegeId: b.collegeId, ignoreBookingId: b.id });
      if (v.accept) {
        placement = checkAccepted(spec, v.accept, ctx);
        if (!placement) {
          return { ok: false, error: "slot_taken", availability: availabilityFor(spec, v.date, v.hour, ctx) };
        }
      } else {
        const availability = availabilityFor(spec, v.date, v.hour, ctx);
        if (availability.kind === "suggestion") return { ok: false, error: "needs_confirmation", availability };
        if (availability.kind === "none") return { ok: false, error: "refused", availability };
        placement = availability.placement;
      }
      await hooks.beforePlacementUpdate?.(placement, attempt);
    }

    const [row] = await tx
      .update(bookings)
      .set({
        doctorName: v.doctorName,
        doctorPhone: phone,
        recipientName: v.recipientName,
        subject: v.subject,
        serviceType: v.serviceType,
        examDate: v.examDate,
        // A new placement also writes the job and clears a reschedule flag.
        ...(placement && { ...spec, ...placement, ...FLAG_CLEARED }),
        updatedAt: now,
      })
      .where(and(eq(bookings.id, b.id), ...guards))
      .returning({
        id: bookings.id,
        reference: bookings.reference,
        collegeId: bookings.collegeId,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
      });
    if (!row) return NOT_EDITABLE; // left `booked` meanwhile (a transition takes no lock)

    if (actor.role === "admin") {
      await audit(tx, actor, {
        action: "booking.admin_edit",
        entity: "bookings",
        entityId: row.id,
        collegeId: row.collegeId,
        details: {
          reference: row.reference,
          from: { machineId: b.machineId, startsAt: b.startsAt, endsAt: b.endsAt },
          to: placement,
        },
      });
      // "The time changes" = the start changes (as for an automatic move, contracts §8.7).
      if (row.startsAt.getTime() !== b.startsAt.getTime()) {
        await notifyCollege(tx, row.collegeId, "booking_rescheduled", row.id, bookingData(row));
      }
    }

    return {
      ok: true,
      booking: { id: row.id, reference: row.reference },
      examDateWarning: examDateWarning(localDate(row.startsAt), v.examDate),
    };
  });
}

/**
 * A college its own `booked` booking until the edit deadline; an admin any `booked` booking. When the job, day and
 * hour are unchanged it is a plain update; otherwise the booking is placed again like a new one (a suggestion is
 * returned, never written, until accepted with `accept`). The reference stays the same.
 */
export async function editBookingFor(
  actor: Actor,
  input: unknown,
  hooks: ChangeHooks = {},
): Promise<EditBookingResult> {
  if (actor.role !== "college" && actor.role !== "admin") throw new AuthError();
  const parsed = editBookingInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const v = parsed.data;
  const phone = normalizePhone(v.doctorPhone);
  if (phone === null) return VALIDATION;

  const seen: { collegeId?: number } = {};
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await tryEdit(actor, v, phone, attempt, hooks, seen);
    } catch (error) {
      if (!isPlacementConflict(error)) throw error;
    }
  }
  const availability =
    seen.collegeId === undefined
      ? null
      : await readAvailability(seen.collegeId, jobOf(v), v.date, v.hour, v.bookingId);
  return availability ? { ok: false, error: "slot_taken", availability } : { ok: false, error: "slot_taken" };
}

// ---- sendDelayNotice

function tryDelay(actor: Actor, bookingId: number, attempt: number, hooks: ChangeHooks): Promise<SendDelayNoticeResult> {
  return getDb().transaction(async (tx): Promise<SendDelayNoticeResult> => {
    await takeSchedulingLock(tx);
    const now = new Date();
    const b = await currentBooking(tx, actor, bookingId);
    if (!b) return NOT_FOUND;

    const { delayDeadlineMinutes } = await loadSettings(tx);
    const inTime = b.startsAt.getTime() >= addMinutes(now, delayDeadlineMinutes).getTime();
    if (b.status !== "booked" || b.delayNoticeAt !== null || b.needsReschedule || !inTime) return REFUSED;

    const ctx = await loadContext(tx, { now, collegeId: b.collegeId, ignoreBookingId: b.id });
    const target = latestFreeStart({ ...jobOf(b), startsAt: b.startsAt }, ctx);
    if (target) await hooks.beforePlacementUpdate?.(target, attempt);

    const [row] = await tx
      .update(bookings)
      .set({
        delayNoticeAt: now,
        delayedFrom: b.startsAt,
        // Found: the booking moves and its old interval is free from now. None: it stays, flagged for the admin.
        ...(target ?? { needsReschedule: true, rescheduleReason: "delay_no_slot" as const }),
        updatedAt: now,
      })
      .where(
        and(
          eq(bookings.id, b.id),
          eq(bookings.status, "booked"),
          isNull(bookings.delayNoticeAt),
          eq(bookings.needsReschedule, false),
          startsAtLeast(now, delayDeadlineMinutes),
          ownRows(actor, bookings.collegeId),
        ),
      )
      .returning({
        id: bookings.id,
        reference: bookings.reference,
        collegeId: bookings.collegeId,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
      });
    if (!row) return REFUSED;

    await audit(tx, actor, {
      action: "booking.delay_notice",
      entity: "bookings",
      entityId: row.id,
      collegeId: row.collegeId,
      details: {
        reference: row.reference,
        from: { machineId: b.machineId, startsAt: b.startsAt, endsAt: b.endsAt },
        to: target, // null = no free interval later that day; flagged `delay_no_slot`
      },
    });
    if (!target) await notifyAdmins(tx, "booking_needs_reschedule", row.id, bookingData(row));

    return {
      ok: true,
      booking: { id: row.id, reference: row.reference, startsAt: row.startsAt, endsAt: row.endsAt },
      moved: target !== null,
    };
  });
}

/**
 * The one delay notice of a booking (college, own; contracts §3.7). Accepted until delay_deadline_minutes before
 * the start. Moves the booking to the latest free start later that day; none → it keeps its time, is flagged
 * `delay_no_slot` and waits in the admin list. Either way the notice is used up.
 */
export async function sendDelayNoticeFor(
  actor: Actor,
  input: unknown,
  hooks: ChangeHooks = {},
): Promise<SendDelayNoticeResult> {
  if (actor.role !== "college") throw new AuthError();
  const parsed = delayInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await tryDelay(actor, parsed.data.bookingId, attempt, hooks);
    } catch (error) {
      if (!isPlacementConflict(error)) throw error;
    }
  }
  return { ok: false, error: "slot_taken" };
}

// ---- moveBooking

type MoveInput = z.infer<typeof moveInput>;

function tryMove(actor: Actor, v: MoveInput, attempt: number, hooks: ChangeHooks): Promise<MoveBookingResult> {
  return getDb().transaction(async (tx): Promise<MoveBookingResult> => {
    await takeSchedulingLock(tx);
    const now = new Date();
    const b = await currentBooking(tx, actor, v.bookingId);
    if (!b) return NOT_FOUND;
    if (b.status !== "booked" && b.status !== "in_progress") return REFUSED;

    const ctx = await loadContext(tx, { now, collegeId: b.collegeId, ignoreBookingId: b.id });
    const target = checkMove(jobOf(b), { status: b.status, startsAt: b.startsAt }, v, ctx);
    if (typeof target === "string") return { ok: false, error: "slot_taken", reason: target };
    await hooks.beforePlacementUpdate?.(target, attempt);

    const [row] = await tx
      .update(bookings)
      .set({ ...target, ...FLAG_CLEARED, updatedAt: now })
      .where(and(eq(bookings.id, b.id), inArray(bookings.status, ["booked", "in_progress"])))
      .returning({
        id: bookings.id,
        reference: bookings.reference,
        collegeId: bookings.collegeId,
        machineId: bookings.machineId,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
      });
    if (!row) return REFUSED; // left a holding state meanwhile (a transition takes no lock)

    await audit(tx, actor, {
      action: "booking.move",
      entity: "bookings",
      entityId: row.id,
      collegeId: row.collegeId,
      details: {
        reference: row.reference,
        from: { machineId: b.machineId, startsAt: b.startsAt, endsAt: b.endsAt },
        to: target,
        flagCleared: b.needsReschedule,
      },
    });
    await notifyCollege(tx, row.collegeId, "booking_rescheduled", row.id, bookingData(row));

    return {
      ok: true,
      booking: { id: row.id, reference: row.reference, machineId: row.machineId, startsAt: row.startsAt, endsAt: row.endsAt },
    };
  });
}

/**
 * The admin places a `booked` or `in_progress` booking on `{ machineId, startsAt }` (contracts §3.7): any booking,
 * flagged or not. The end comes from that machine's duration. Clears the flag; audited; `booking_rescheduled` to
 * the college. A target that fails a rule → `slot_taken` with the reason; nothing changes.
 */
export async function moveBookingFor(actor: Actor, input: unknown, hooks: ChangeHooks = {}): Promise<MoveBookingResult> {
  if (actor.role !== "admin") throw new AuthError();
  const parsed = moveInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await tryMove(actor, parsed.data, attempt, hooks);
    } catch (error) {
      if (!isPlacementConflict(error)) throw error;
    }
  }
  return { ok: false, error: "slot_taken", reason: "busy" };
}
