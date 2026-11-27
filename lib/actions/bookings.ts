"use server";
// Booking actions (contracts §4 "Bookings"). Every export of this file is a public endpoint:
// the role guard is the first line of each one; the work is in lib/bookings/.
import { requireRole } from "@/lib/auth/guard";
import {
  createBookingFor,
  getAvailabilityFor,
  type CreateBookingResult,
  type GetAvailabilityResult,
} from "@/lib/bookings/create";
import {
  editBookingFor,
  moveBookingFor,
  sendDelayNoticeFor,
  type EditBookingResult,
  type MoveBookingResult,
  type SendDelayNoticeResult,
} from "@/lib/bookings/change";
import {
  cancelBookingFor,
  confirmIdentityFor,
  markDeliveredFor,
  markNoShowFor,
  markReadyFor,
  type TransitionResult,
} from "@/lib/bookings/lifecycle";
import {
  getBookingFor,
  getBookingFormConfigFor,
  getWhatsAppLinkFor,
  listBookingsFor,
  listNeedsRescheduleFor,
  type BookingFormConfig,
  type GetBookingResult,
  type GetWhatsAppLinkResult,
  type ListBookingsResult,
  type ListNeedsRescheduleResult,
} from "@/lib/bookings/read";

import { getDayQueueFor, type GetDayQueueResult } from "@/lib/bookings/queue";

const BOOKERS = ["college", "admin"] as const;
const QUEUE_READERS = ["operator", "admin"] as const;
const STAFF = ["operator", "admin"] as const;

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

/**
 * §3.7 `{ bookingId, ...BookingForm, date, hour, accept? }`. A college its own `booked` booking until
 * edit_deadline_minutes before the start; an admin any `booked` booking. The reference stays the same.
 */
export async function editBooking(input: unknown): Promise<EditBookingResult> {
  const actor = await requireRole(BOOKERS);
  return editBookingFor(actor, input);
}

/** T5 / T6 `{ bookingId, reason? }`. A college its own `booked` booking until the edit deadline; an admin also an
 * `in_progress` one, with a reason. */
export async function cancelBooking(input: unknown): Promise<TransitionResult> {
  const actor = await requireRole(BOOKERS);
  return cancelBookingFor(actor, input);
}

/** §3.7 `{ bookingId }`: the one delay notice of an own booking. The admin uses moveBooking instead. */
export async function sendDelayNotice(input: unknown): Promise<SendDelayNoticeResult> {
  const actor = await requireRole(["college"]);
  return sendDelayNoticeFor(actor, input);
}

/** The admin list of bookings flagged `needs_reschedule`, earliest start first. */
export async function listNeedsReschedule(): Promise<ListNeedsRescheduleResult> {
  await requireRole(["admin"]);
  return listNeedsRescheduleFor();
}

/** §3.7 `{ bookingId, machineId, startsAt }`: the admin places a booked or in_progress booking; clears its flag. */
export async function moveBooking(input: unknown): Promise<MoveBookingResult> {
  const actor = await requireRole(["admin"]);
  return moveBookingFor(actor, input);
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

/** The daily printed sheet (step 4.1): the same rows as the day queue, laid out for paper by the page. Read-only. */
export async function getDailySheet(date: unknown): Promise<GetDayQueueResult> {
  await requireRole(QUEUE_READERS);
  return getDayQueueFor(date);
}

/** One booking: a college its own only (without the machine); an operator or an admin any booking. */
export async function getBooking(input: unknown): Promise<GetBookingResult> {
  const actor = await requireRole(["college", "operator", "admin"]);
  return getBookingFor(actor, input);
}

/** T2 `{ bookingId }`: identity checked, the job starts. */
export async function confirmIdentity(input: unknown): Promise<TransitionResult> {
  const actor = await requireRole(STAFF);
  return confirmIdentityFor(actor, input);
}

/** T3 `{ bookingId, wastedSheets, wasteDestroyed: true }`. */
export async function markReady(input: unknown): Promise<TransitionResult> {
  const actor = await requireRole(STAFF);
  return markReadyFor(actor, input);
}

/** T4 `{ bookingId }`: handed over. */
export async function markDelivered(input: unknown): Promise<TransitionResult> {
  const actor = await requireRole(STAFF);
  return markDeliveredFor(actor, input);
}

/** T7 `{ bookingId }`: nobody came; the time is released. */
export async function markNoShow(input: unknown): Promise<TransitionResult> {
  const actor = await requireRole(STAFF);
  return markNoShowFor(actor, input);
}

/** `{ bookingId, kind: 'started' | 'ready' }` → the wa.me link to the doctor. Writes nothing. */
export async function getWhatsAppLink(input: unknown): Promise<GetWhatsAppLinkResult> {
  const actor = await requireRole(STAFF);
  return getWhatsAppLinkFor(actor, input);
}
