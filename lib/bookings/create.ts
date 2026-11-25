// Booking creation and availability (contracts §2 T1, §3.9, §4). The server actions in lib/actions/bookings.ts
// run the role guard and call these. Not a "use server" file: nothing here is a public endpoint.
import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Executor } from "@/db";
import { bookings, colleges } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import { AuthError, collegeScope, type Actor } from "@/lib/auth/guard";
import { availabilityFor, checkAccepted, type Availability } from "@/lib/scheduling/availability";
import { examDateWarning, formatReference, isFourPartName, normalizePhone } from "@/lib/scheduling/helpers";
import { bookingData, notifyCollege } from "@/lib/notifications";
import { loadContext, takeSchedulingLock } from "@/lib/scheduling/load";
import { localDate } from "@/lib/scheduling/time";
import type { JobSpec, Placement } from "@/lib/scheduling/types";

/** Retries after the first try when the placement hits a conflict; a constant, not a setting (contracts §5). */
export const MAX_RETRIES = 3;

export type CreateBookingResult =
  | { ok: true; booking: { id: number; reference: string }; examDateWarning: boolean }
  | {
      ok: false;
      error: "validation" | "slot_taken" | "needs_confirmation" | "refused";
      availability?: Availability;
    };

export type GetAvailabilityResult = { ok: true; availability: Availability } | { ok: false; error: "validation" };

/** For tests only: runs under the lock, right before the INSERT of try number `attempt` (0 = the first). */
export interface CreateBookingHooks {
  beforeInsert?(placement: Placement, attempt: number): Promise<void>;
}

// ---- input (rule 4: validated before the transaction; bounds = the §1.7 CHECKs)

const id = z.number().int().positive();
const text = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !s.includes("\u0000")); // PostgreSQL text cannot hold it
/** 'YYYY-MM-DD' that names a real calendar day ('2026-02-30' does not). */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}
const dateString = z.string().refine(isCalendarDate);
const job = {
  copies: z.number().int().min(1).max(20_000),
  models: z.number().int().min(1).max(50),
  pagesPerModel: z.number().int().min(1).max(500),
  sides: z.enum(["single", "duplex"]),
};
const request = { collegeId: id.optional(), date: dateString, hour: z.number().int().min(0).max(23) };

const createBookingInput = z.object({
  ...job,
  ...request,
  doctorName: text,
  doctorPhone: z.string().max(40),
  recipientName: text.refine(isFourPartName),
  subject: text,
  serviceType: z.enum(["exam_questions", "results", "quality", "answer_sheets"]),
  examDate: dateString.nullable(),
  // Only the machine and the start of an accepted suggestion are used; the end is computed on the server.
  // The bounds keep date arithmetic on it inside the range of Date.
  accept: z
    .object({ machineId: id, startsAt: z.date().min(new Date(0)).max(new Date("9999-12-31T00:00:00Z")) })
    .optional(),
});

// Strict: `bookingId` (availability for an edit) arrives with step 2.3 and must not be silently ignored until then.
const getAvailabilityInput = z.strictObject({ ...job, ...request });

const VALIDATION = { ok: false, error: "validation" } as const;

/**
 * Rules 2–3: the college this request is for. A college user's comes from the session and a `collegeId` in the
 * request is refused, valid or not; an admin must name one (null = none given).
 */
function requestedCollege(actor: Actor, input: unknown, parsedCollegeId: number | undefined): number | null {
  if (actor.role !== "college" && actor.role !== "admin") throw new AuthError();
  const raw = typeof input === "object" && input !== null ? (input as { collegeId?: unknown }).collegeId : undefined;
  if (raw !== undefined && actor.role !== "admin") throw new AuthError();
  return collegeScope(actor, parsedCollegeId);
}

async function isActiveCollege(ex: Executor, collegeId: number): Promise<boolean> {
  const [college] = await ex.select({ isActive: colleges.isActive }).from(colleges).where(eq(colleges.id, collegeId));
  return college?.isActive === true;
}

function jobOf(v: JobSpec): JobSpec {
  return { models: v.models, pagesPerModel: v.pagesPerModel, copies: v.copies, sides: v.sides };
}

/** 23P01 = exclusion constraint (`bookings_no_overlap`), 40P01 = deadlock. Drizzle wraps the driver error in `cause`. */
export function isPlacementConflict(error: unknown): boolean {
  for (let e = error as { code?: unknown; cause?: unknown } | null | undefined, depth = 0; e && depth < 10; depth++) {
    if (e.code === "23P01" || e.code === "40P01") return true;
    e = e.cause as typeof e;
  }
  return false;
}

// ---- getAvailability: writes nothing, takes no lock

/** One consistent snapshot: the answer never mixes rows from before and after another booking's commit. */
function readAvailability(collegeId: number, spec: JobSpec, date: string, hour: number): Promise<Availability | null> {
  return getDb().transaction(
    async (tx) => {
      if (!(await isActiveCollege(tx, collegeId))) return null;
      return availabilityFor(spec, date, hour, await loadContext(tx, { now: new Date(), collegeId }));
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function getAvailabilityFor(actor: Actor, input: unknown): Promise<GetAvailabilityResult> {
  const parsed = getAvailabilityInput.safeParse(input);
  const collegeId = requestedCollege(actor, input, parsed.data?.collegeId);
  if (!parsed.success || collegeId === null) return VALIDATION;
  const v = parsed.data;
  const availability = await readAvailability(collegeId, jobOf(v), v.date, v.hour);
  return availability ? { ok: true, availability } : VALIDATION;
}

// ---- createBooking (T1)

type CreateInput = z.infer<typeof createBookingInput>;

/** One try: lock, load, decide, write. Throws on a placement conflict; the caller retries from the start. */
function tryCreate(
  actor: Actor,
  v: CreateInput,
  phone: string,
  collegeId: number,
  attempt: number,
  hooks: CreateBookingHooks,
): Promise<CreateBookingResult> {
  // READ COMMITTED (the default): every read below sees what was committed before the lock was granted.
  return getDb().transaction(async (tx): Promise<CreateBookingResult> => {
    await takeSchedulingLock(tx);
    const now = new Date(); // after the wait for the lock, never before
    if (!(await isActiveCollege(tx, collegeId))) return VALIDATION;

    const spec = jobOf(v);
    const ctx = await loadContext(tx, { now, collegeId });

    let placement: Placement;
    if (v.accept) {
      const accepted = checkAccepted(spec, v.accept, ctx);
      if (!accepted) {
        return { ok: false, error: "slot_taken", availability: availabilityFor(spec, v.date, v.hour, ctx) };
      }
      placement = accepted;
    } else {
      const availability = availabilityFor(spec, v.date, v.hour, ctx);
      if (availability.kind === "suggestion") return { ok: false, error: "needs_confirmation", availability };
      if (availability.kind === "none") return { ok: false, error: "refused", availability };
      placement = availability.placement;
    }

    await hooks.beforeInsert?.(placement, attempt);

    // Reference number, under the same lock; UNIQUE (ref_year, ref_seq) is the backstop.
    const refYear = Number(localDate(now).slice(0, 4));
    const [{ refSeq }] = await tx
      .select({ refSeq: sql<number>`coalesce(max(${bookings.refSeq}), 0) + 1`.mapWith(Number) })
      .from(bookings)
      .where(eq(bookings.refYear, refYear));
    const reference = formatReference(refYear, refSeq);
    const onBehalf = actor.role === "admin";

    const [row] = await tx
      .insert(bookings)
      .values({
        refYear,
        refSeq,
        reference,
        collegeId,
        createdBy: actor.userId,
        onBehalf,
        doctorName: v.doctorName,
        doctorPhone: phone,
        recipientName: v.recipientName,
        subject: v.subject,
        serviceType: v.serviceType,
        copies: v.copies,
        models: v.models,
        pagesPerModel: v.pagesPerModel,
        sides: v.sides,
        examDate: v.examDate,
        machineId: placement.machineId,
        startsAt: placement.startsAt,
        endsAt: placement.endsAt,
      })
      .returning({ id: bookings.id });

    if (onBehalf) {
      await notifyCollege(
        tx,
        collegeId,
        "booking_on_behalf",
        row.id,
        bookingData({ reference, startsAt: placement.startsAt, endsAt: placement.endsAt }),
      );
      await audit(tx, actor, {
        action: "booking.create_on_behalf",
        entity: "bookings",
        entityId: row.id,
        collegeId,
        details: { reference, machineId: placement.machineId, startsAt: placement.startsAt, endsAt: placement.endsAt },
      });
    }

    return {
      ok: true,
      booking: { id: row.id, reference },
      examDateWarning: examDateWarning(localDate(placement.startsAt), v.examDate),
    };
  });
}

export async function createBookingFor(
  actor: Actor,
  input: unknown,
  hooks: CreateBookingHooks = {},
): Promise<CreateBookingResult> {
  const parsed = createBookingInput.safeParse(input);
  const collegeId = requestedCollege(actor, input, parsed.data?.collegeId);
  if (!parsed.success || collegeId === null) return VALIDATION;
  const v = parsed.data;
  const phone = normalizePhone(v.doctorPhone);
  if (phone === null) return VALIDATION;

  // `bookings_no_overlap` is the final authority: a conflict rolls the whole try back and it starts again.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await tryCreate(actor, v, phone, collegeId, attempt, hooks);
    } catch (error) {
      if (!isPlacementConflict(error)) throw error;
    }
  }
  const availability = await readAvailability(collegeId, jobOf(v), v.date, v.hour);
  return availability ? { ok: false, error: "slot_taken", availability } : VALIDATION;
}
