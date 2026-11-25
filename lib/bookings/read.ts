// Reads for the booking screens (contracts §4 "Bookings"). The server actions in lib/actions/bookings.ts run the
// role guard first and call these. Not a "use server" file: nothing here is a public endpoint.
import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { bookings, colleges, machines } from "@/db/schema";
import { AuthError, collegeScope, type Actor } from "@/lib/auth/guard";
import { whatsAppLink, type WhatsAppKind } from "@/lib/scheduling/helpers";
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

// ---- getBooking: one booking. A college: its own only (another college's answers "not found") and no machine,
// as in its list. An operator or an admin: any booking, with the machine.

export interface BookingDetail {
  id: number;
  reference: string;
  collegeId: number;
  collegeName: string;
  onBehalf: boolean;
  doctorName: string;
  doctorPhone: string;
  recipientName: string;
  subject: string;
  serviceType: ServiceType;
  copies: number;
  models: number;
  pagesPerModel: number;
  sides: Sides;
  examDate: string | null;
  impressions: number;
  sheets: number;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
  needsReschedule: boolean;
  delayNoticeAt: Date | null;
  identityConfirmedAt: Date | null;
  readyAt: Date | null;
  wastedSheets: number | null;
  deliveredAt: Date | null;
  noShowAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  /** Operator and admin only; null for a college. */
  machineName: string | null;
}

export type GetBookingResult = { ok: true; booking: BookingDetail } | { ok: false; error: "validation" | "not_found" };

const bookingIdInput = z.strictObject({ bookingId: z.number().int().positive() });

export async function getBookingFor(actor: Actor, input: unknown): Promise<GetBookingResult> {
  const parsed = bookingIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const scope = collegeScope(actor);
  const [row] = await getDb()
    .select({
      id: bookings.id,
      reference: bookings.reference,
      collegeId: bookings.collegeId,
      collegeName: colleges.name,
      onBehalf: bookings.onBehalf,
      doctorName: bookings.doctorName,
      doctorPhone: bookings.doctorPhone,
      recipientName: bookings.recipientName,
      subject: bookings.subject,
      serviceType: bookings.serviceType,
      copies: bookings.copies,
      models: bookings.models,
      pagesPerModel: bookings.pagesPerModel,
      sides: bookings.sides,
      examDate: bookings.examDate,
      impressions: bookings.impressions,
      sheets: bookings.sheets,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      status: bookings.status,
      needsReschedule: bookings.needsReschedule,
      delayNoticeAt: bookings.delayNoticeAt,
      identityConfirmedAt: bookings.identityConfirmedAt,
      readyAt: bookings.readyAt,
      wastedSheets: bookings.wastedSheets,
      deliveredAt: bookings.deliveredAt,
      noShowAt: bookings.noShowAt,
      cancelledAt: bookings.cancelledAt,
      cancelReason: bookings.cancelReason,
      machineName: machines.name,
    })
    .from(bookings)
    .innerJoin(colleges, eq(colleges.id, bookings.collegeId))
    .innerJoin(machines, eq(machines.id, bookings.machineId))
    .where(and(eq(bookings.id, parsed.data.bookingId), scope === null ? undefined : eq(bookings.collegeId, scope)));
  if (!row) return { ok: false, error: "not_found" };
  // `impressions` and `sheets` are generated from NOT NULL columns; Drizzle types generated columns as nullable.
  const booking = { ...row, impressions: row.impressions!, sheets: row.sheets! };
  return { ok: true, booking: { ...booking, machineName: scope === null ? row.machineName : null } };
}

// ---- getWhatsAppLink (operator, admin): "started" only while in_progress, "ready" only while ready (contracts §2).

export type GetWhatsAppLinkResult = { ok: true; url: string } | { ok: false; error: "validation" | "not_found" | "refused" };

const whatsAppInput = z.strictObject({ bookingId: z.number().int().positive(), kind: z.enum(["started", "ready"]) });
const SHOWN_WHILE: Record<WhatsAppKind, BookingStatus> = { started: "in_progress", ready: "ready" };

export async function getWhatsAppLinkFor(actor: Actor, input: unknown): Promise<GetWhatsAppLinkResult> {
  if (actor.role !== "operator" && actor.role !== "admin") throw new AuthError();
  const parsed = whatsAppInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const { bookingId, kind } = parsed.data;
  const [row] = await getDb()
    .select({
      status: bookings.status,
      doctorPhone: bookings.doctorPhone,
      subject: bookings.subject,
      reference: bookings.reference,
      collegeName: colleges.name,
      machineName: machines.name,
    })
    .from(bookings)
    .innerJoin(colleges, eq(colleges.id, bookings.collegeId))
    .innerJoin(machines, eq(machines.id, bookings.machineId))
    .where(eq(bookings.id, bookingId));
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== SHOWN_WHILE[kind]) return { ok: false, error: "refused" };
  return { ok: true, url: whatsAppLink(kind, row) };
}

// ---- listNeedsReschedule: the admin list (contracts §3.8). Each row is resolved by moveBooking or cancelBooking.

export interface NeedsRescheduleItem {
  id: number;
  reference: string;
  collegeId: number;
  collegeName: string;
  machineId: number;
  machineName: string;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
  rescheduleReason: "maintenance" | "delay_no_slot" | "machine_change";
  delayedFrom: Date | null;
  subject: string;
  impressions: number;
}

export type ListNeedsRescheduleResult = { ok: true; bookings: NeedsRescheduleItem[] };

/** Every flagged booking, earliest start first. Admin only (the action's guard). */
export async function listNeedsRescheduleFor(): Promise<ListNeedsRescheduleResult> {
  const rows = await getDb()
    .select({
      id: bookings.id,
      reference: bookings.reference,
      collegeId: bookings.collegeId,
      collegeName: colleges.name,
      machineId: bookings.machineId,
      machineName: machines.name,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      status: bookings.status,
      rescheduleReason: bookings.rescheduleReason,
      delayedFrom: bookings.delayedFrom,
      subject: bookings.subject,
      impressions: bookings.impressions,
    })
    .from(bookings)
    .innerJoin(colleges, eq(colleges.id, bookings.collegeId))
    .innerJoin(machines, eq(machines.id, bookings.machineId))
    .where(eq(bookings.needsReschedule, true))
    .orderBy(bookings.startsAt, bookings.id);
  // CHECK (needs_reschedule = (reschedule_reason IS NOT NULL)): a flagged row always has its reason.
  return {
    ok: true,
    bookings: rows.map((r) => ({ ...r, rescheduleReason: r.rescheduleReason!, impressions: r.impressions! })),
  };
}
