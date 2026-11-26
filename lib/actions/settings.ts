"use server";
// Settings and holidays actions (contracts §4 "Settings", §5). Every export of this file is a public endpoint: the
// role guard is the first line of each one; the work is in lib/settings/.
import { requireRole } from "@/lib/auth/guard";
import {
  addHolidayFor,
  getSettingsFor,
  listHolidaysFor,
  removeHolidayFor,
  updateSettingsFor,
  type AddHolidayResult,
  type GetSettingsResult,
  type ListHolidaysResult,
  type RemoveHolidayResult,
  type UpdateSettingsResult,
} from "@/lib/settings";

/** Admin only: every §5 key, camelCase. */
export async function getSettings(): Promise<GetSettingsResult> {
  const actor = await requireRole(["admin"]);
  return getSettingsFor(actor);
}

/** Admin only: a partial patch of §5 keys (camelCase); all saved or none. */
export async function updateSettings(input: unknown): Promise<UpdateSettingsResult> {
  const actor = await requireRole(["admin"]);
  return updateSettingsFor(actor, input);
}

/** Admin only: every holiday, newest date first. */
export async function listHolidays(): Promise<ListHolidaysResult> {
  const actor = await requireRole(["admin"]);
  return listHolidaysFor(actor);
}

/** Admin only: `{ date, name }`, a date today or later; refused with the list while the date has holding bookings. */
export async function addHoliday(input: unknown): Promise<AddHolidayResult> {
  const actor = await requireRole(["admin"]);
  return addHolidayFor(actor, input);
}

/** Admin only: `{ date }`, a holiday dated today or later. */
export async function removeHoliday(input: unknown): Promise<RemoveHolidayResult> {
  const actor = await requireRole(["admin"]);
  return removeHolidayFor(actor, input);
}
