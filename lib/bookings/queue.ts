// Step 1.7 — the operator's day queue (contracts §4 `getDayQueue`). Read-only: nothing is written.
// The role guard is in lib/actions/bookings.ts; this file only reads.
import "server-only";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { bookings, colleges, machines } from "@/db/schema";
import { atMinutes, localDate } from "@/lib/scheduling/time";

export interface DayQueueRow {
  id: number;
  reference: string;
  startsAt: Date;
  endsAt: Date;
  machineId: number;
  machineName: string;
  collegeName: string;
  doctorName: string;
  recipientName: string;
  subject: string;
  serviceType: (typeof bookings.$inferSelect)["serviceType"];
  copies: number;
  models: number;
  pagesPerModel: number;
  sides: (typeof bookings.$inferSelect)["sides"];
  status: (typeof bookings.$inferSelect)["status"];
  needsReschedule: boolean;
}

export type GetDayQueueResult = { ok: true; date: string; rows: DayQueueRow[] } | { ok: false; error: "validation" };

/** 'YYYY-MM-DD' that is a real calendar date (2026-02-30 is not). */
const dateInput = z
  .string()
  .refine((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && localDate(atMinutes(d, 0)) === d);

/**
 * The day's bookings by start time, then machine: every status except `cancelled` (owner, 2026-11-25).
 * `date` is a business date ('YYYY-MM-DD', Tripoli); a booking belongs to the day it starts on (`work_date`).
 */
export async function getDayQueueFor(date: unknown): Promise<GetDayQueueResult> {
  const parsed = dateInput.safeParse(date);
  if (!parsed.success) return { ok: false, error: "validation" };

  const rows = await getDb()
    .select({
      id: bookings.id,
      reference: bookings.reference,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      machineId: bookings.machineId,
      machineName: machines.name,
      collegeName: colleges.name,
      doctorName: bookings.doctorName,
      recipientName: bookings.recipientName,
      subject: bookings.subject,
      serviceType: bookings.serviceType,
      copies: bookings.copies,
      models: bookings.models,
      pagesPerModel: bookings.pagesPerModel,
      sides: bookings.sides,
      status: bookings.status,
      needsReschedule: bookings.needsReschedule,
    })
    .from(bookings)
    .innerJoin(machines, eq(machines.id, bookings.machineId))
    .innerJoin(colleges, eq(colleges.id, bookings.collegeId))
    .where(and(eq(bookings.workDate, parsed.data), ne(bookings.status, "cancelled")))
    .orderBy(asc(bookings.startsAt), asc(bookings.machineId), asc(bookings.id));

  return { ok: true, date: parsed.data, rows };
}
