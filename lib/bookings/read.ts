// Reads for the booking screens (contracts §4 "Bookings"). The server actions in lib/actions/bookings.ts run the
// role guard first and call these. Not a "use server" file: nothing here is a public endpoint.
import "server-only";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { bookings } from "@/db/schema";
import { AuthError, collegeScope, type Actor } from "@/lib/auth/guard";
import { loadSettings } from "@/lib/scheduling/load";
import { localDate } from "@/lib/scheduling/time";
import type { BookingStatus, ServiceType, Sides } from "@/lib/scheduling/types";

/** One row of the own-bookings list. No machine: a college does not see which machine runs its job. */
export interface BookingListItem {
  id: number;
  reference: string;
  collegeId: number;
  startsAt: Date;
  endsAt: Date;
  subject: string;
  serviceType: ServiceType;
  copies: number;
  models: number;
  pagesPerModel: number;
  sides: Sides;
  status: BookingStatus;
}

export type ListBookingsResult = { ok: true; bookings: BookingListItem[] } | { ok: false; error: "validation" };

// Strict: an unknown key is a mistake, not something to ignore silently.
const listBookingsInput = z.strictObject({ collegeId: z.number().int().positive().optional() });

/**
 * Rules 2–3: a college user gets its own rows (a `collegeId` in the request is refused, valid or not);
 * an admin gets all rows, or one college's when it passes `collegeId`. Newest start first.
 */
export async function listBookingsFor(actor: Actor, input: unknown): Promise<ListBookingsResult> {
  const raw = typeof input === "object" && input !== null ? (input as { collegeId?: unknown }).collegeId : undefined;
  // Before the parse result is looked at: a non-admin that names a college is refused, valid or not.
  if (raw !== undefined && actor.role !== "admin") throw new AuthError();
  const parsed = listBookingsInput.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: "validation" };
  const scope = collegeScope(actor, parsed.data.collegeId);

  const rows = await getDb()
    .select({
      id: bookings.id,
      reference: bookings.reference,
      collegeId: bookings.collegeId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      subject: bookings.subject,
      serviceType: bookings.serviceType,
      copies: bookings.copies,
      models: bookings.models,
      pagesPerModel: bookings.pagesPerModel,
      sides: bookings.sides,
      status: bookings.status,
    })
    .from(bookings)
    .where(scope === null ? undefined : eq(bookings.collegeId, scope))
    .orderBy(desc(bookings.startsAt), desc(bookings.id));
  return { ok: true, bookings: rows };
}

/** What the booking form needs from the settings, and nothing else (a college cannot read the settings). */
export interface BookingFormConfig {
  workStart: string; // 'HH:MM'
  workEnd: string;
  workingWeekdays: number[]; // 0 = Sunday … 6 = Saturday
  today: string; // 'YYYY-MM-DD', the server's business date
}

export async function getBookingFormConfigFor(): Promise<BookingFormConfig> {
  const settings = await loadSettings(getDb());
  return {
    workStart: settings.workStart,
    workEnd: settings.workEnd,
    workingWeekdays: settings.workingWeekdays,
    today: localDate(new Date()),
  };
}
