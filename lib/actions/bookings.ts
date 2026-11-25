"use server";
// Booking actions (contracts §4 "Bookings"). Every export of this file is a public endpoint:
// the role guard is the first line of each one; the work is in lib/bookings/create.ts.
import { requireRole } from "@/lib/auth/guard";
import {
  createBookingFor,
  getAvailabilityFor,
  type CreateBookingResult,
  type GetAvailabilityResult,
} from "@/lib/bookings/create";
import {
  getBookingFormConfigFor,
  listBookingsFor,
  type BookingFormConfig,
  type ListBookingsResult,
} from "@/lib/bookings/read";

import { getDayQueueFor, type GetDayQueueResult } from "@/lib/bookings/queue";

const BOOKERS = ["college", "admin"] as const;
const QUEUE_READERS = ["operator", "admin"] as const;

/** An exact placement, a suggestion or a refusal for (job, date, hour). Writes nothing. */
export async function getAvailability(input: unknown): Promise<GetAvailabilityResult> {
  const actor = await requireRole(BOOKERS);
  return getAvailabilityFor(actor, input);
}

/** T1. A college books for itself; an admin books on behalf of `collegeId`. */
export async function createBooking(input: unknown): Promise<CreateBookingResult> {
  const actor = await requireRole(BOOKERS);
  return createBookingFor(actor, input);
}

/** A college: its own bookings. An admin: all, or one college's with `{ collegeId }`. Newest first. */
export async function listBookings(input?: unknown): Promise<ListBookingsResult> {
  const actor = await requireRole(BOOKERS);
  return listBookingsFor(actor, input);
}

/** Working hours, working weekdays and today's date for the booking form. Nothing else from the settings. */
export async function getBookingFormConfig(): Promise<BookingFormConfig> {
  await requireRole(BOOKERS);
  return getBookingFormConfigFor();
}

/** The operator's day queue: bookings of one business date by start time and machine; read-only. */
export async function getDayQueue(date: unknown): Promise<GetDayQueueResult> {
  await requireRole(QUEUE_READERS);
  return getDayQueueFor(date);
}
