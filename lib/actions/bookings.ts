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

const BOOKERS = ["college", "admin"] as const;

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
