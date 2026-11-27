"use server";
// Report actions (contracts §4 "Reports and audit"). Every export of this file is a public endpoint: the role guard
// is the first line of each one; the work is in lib/reports/. Admin only.
import { requireRole } from "@/lib/auth/guard";
import {
  reportByCollegeFor,
  reportByMachineFor,
  reportPeakHoursFor,
  reportWasteAndStockFor,
  type CollegeReportResult,
  type MachineReportResult,
  type PeakHoursResult,
  type WasteAndStockResult,
} from "@/lib/reports";

/** Admin only: per college, bookings starting from `from` to `to` (business dates, both inclusive). */
export async function reportByCollege(from: unknown, to: unknown): Promise<CollegeReportResult> {
  const actor = await requireRole(["admin"]);
  return reportByCollegeFor(actor, from, to);
}

/** Admin only: per machine, bookings, booked minutes and downtime in the range. */
export async function reportByMachine(from: unknown, to: unknown): Promise<MachineReportResult> {
  const actor = await requireRole(["admin"]);
  return reportByMachineFor(actor, from, to);
}

/** Admin only: wasted sheets of the bookings finished in the range, and stock movements by item and type. */
export async function reportWasteAndStock(from: unknown, to: unknown): Promise<WasteAndStockResult> {
  const actor = await requireRole(["admin"]);
  return reportWasteAndStockFor(actor, from, to);
}

/** Admin only: bookings and impressions by the hour of `starts_at`. */
export async function reportPeakHours(from: unknown, to: unknown): Promise<PeakHoursResult> {
  const actor = await requireRole(["admin"]);
  return reportPeakHoursFor(actor, from, to);
}
