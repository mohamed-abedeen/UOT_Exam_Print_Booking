// Settings and holidays (contracts §1.12, §4 "Settings", §5). Admin only; the server actions in
// lib/actions/settings.ts run the role guard and call these. Not a "use server" file.
// Changing hours or weekdays never moves existing bookings (§5). A holiday closes its date for everyone; `addHoliday`
// takes the scheduling lock and is refused while the date has holding bookings (§3.9, §5). Removing one only adds
// room, so it takes no lock (as a Saturday approval).
import "server-only";
import { and, asc, desc, eq, gt, lt, notInArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { bookings, holidays, settings as settingsTable, users } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import { AuthError, type Actor } from "@/lib/auth/guard";
import { dateString, VALIDATION } from "@/lib/bookings/create";
import { loadSettings, takeSchedulingLock } from "@/lib/scheduling/load";
import { addDays, atMinutes, localDate, minutesOfDay } from "@/lib/scheduling/time";
import type { Settings } from "@/lib/scheduling/types";

/** `Settings` field → `settings.key` (contracts §5). */
const KEY_OF: Record<keyof Settings, string> = {
  workStart: "work_start",
  workEnd: "work_end",
  workingWeekdays: "working_weekdays",
  largeJobThreshold: "large_job_threshold",
  largeJobsPerDay: "large_jobs_per_day",
  editDeadlineMinutes: "edit_deadline_minutes",
  delayDeadlineMinutes: "delay_deadline_minutes",
  suggestionSearchDays: "suggestion_search_days",
  partWarnPercent: "part_warn_percent",
};

const INT_MAX = 2_147_483_647;
const gridTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]0$/); // HH:MM on the 10-minute grid
const weekdays = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .refine((days) => new Set(days).size === days.length)
  .transform((days) => [...days].sort((a, b) => a - b));
const count = (min: number, max = INT_MAX) => z.number().int().min(min).max(max);

const updateInput = z
  .strictObject({
    workStart: gridTime,
    workEnd: gridTime,
    workingWeekdays: weekdays,
    largeJobThreshold: count(1),
    largeJobsPerDay: count(0),
    editDeadlineMinutes: count(0),
    delayDeadlineMinutes: count(0),
    suggestionSearchDays: count(1, 60),
    partWarnPercent: count(1, 100),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0);

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !s.includes("\u0000")); // PostgreSQL text cannot hold it
const addHolidayInput = z.strictObject({ date: dateString, name: text(200) });
const removeHolidayInput = z.strictObject({ date: dateString });

function requireAdmin(actor: Actor): void {
  if (actor.role !== "admin") throw new AuthError();
}

// ---- getSettings, updateSettings

export type GetSettingsResult = { ok: true; settings: Settings };

export async function getSettingsFor(actor: Actor): Promise<GetSettingsResult> {
  requireAdmin(actor);
  return { ok: true, settings: await loadSettings(getDb()) };
}

export type UpdateSettingsResult = { ok: true; settings: Settings } | { ok: false; error: "validation" };

/**
 * A partial patch: only the keys sent change; every key sent is validated and either all are saved or none (owner,
 * 2026-11-26, step 2.6b). `workEnd > workStart` is checked on the merged values. The settings rows are locked for the
 * transaction so two admins cannot each save half of an invalid pair. One `settings.update` audit row lists each key
 * whose value changed (`from`, `to`); a patch that changes nothing writes nothing.
 */
export async function updateSettingsFor(actor: Actor, input: unknown): Promise<UpdateSettingsResult> {
  requireAdmin(actor);
  const parsed = updateInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const patch = parsed.data as Partial<Settings>;

  return getDb().transaction(async (tx): Promise<UpdateSettingsResult> => {
    await tx.select({ key: settingsTable.key }).from(settingsTable).for("update");
    const current = await loadSettings(tx);
    const next: Settings = { ...current, ...patch };
    if (minutesOfDay(next.workEnd) <= minutesOfDay(next.workStart)) return VALIDATION;

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const now = new Date();
    for (const field of Object.keys(patch) as (keyof Settings)[]) {
      const from = current[field];
      const to = next[field];
      if (JSON.stringify(from) === JSON.stringify(to)) continue;
      const key = KEY_OF[field];
      changes[key] = { from, to };
      await tx
        .insert(settingsTable)
        .values({ key, value: to, updatedBy: actor.userId, updatedAt: now })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value: to, updatedBy: actor.userId, updatedAt: now } });
    }
    if (Object.keys(changes).length > 0) {
      await audit(tx, actor, { action: "settings.update", entity: "settings", details: { changes } });
    }
    return { ok: true, settings: next };
  });
}

// ---- listHolidays, addHoliday, removeHoliday

export interface HolidayItem {
  date: string;
  name: string;
  createdByName: string;
  createdAt: Date;
}
export type ListHolidaysResult = { ok: true; items: HolidayItem[] };

/** Every holiday, past ones too, newest date first; no paging (owner, 2026-11-26, step 2.6b). */
export async function listHolidaysFor(actor: Actor): Promise<ListHolidaysResult> {
  requireAdmin(actor);
  const items = await getDb()
    .select({ date: holidays.date, name: holidays.name, createdByName: users.fullName, createdAt: holidays.createdAt })
    .from(holidays)
    .innerJoin(users, eq(users.id, holidays.createdBy))
    .orderBy(desc(holidays.date));
  return { ok: true, items };
}

export type HolidayBooking = { id: number; reference: string; startsAt: Date };
export type AddHolidayResult =
  | { ok: true; holiday: { date: string; name: string } }
  | { ok: false; error: "validation" | "duplicate" }
  | { ok: false; error: "has_bookings"; bookings: HolidayBooking[] }; // the admin moves or cancels them first

/**
 * A holiday on a date today or later (owner, 2026-11-26, step 2.6b). Under the scheduling lock, so no booking can be
 * placed on the date between the check and the insert. Refused while a holding booking (every status except
 * cancelled and no_show) overlaps the business day; the answer lists them by start. Audited `holiday.add`.
 */
export async function addHolidayFor(actor: Actor, input: unknown): Promise<AddHolidayResult> {
  requireAdmin(actor);
  const parsed = addHolidayInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const v = parsed.data;

  return getDb().transaction(async (tx): Promise<AddHolidayResult> => {
    await takeSchedulingLock(tx);
    if (v.date < localDate(new Date())) return VALIDATION; // clock read after the lock

    const [existing] = await tx.select({ date: holidays.date }).from(holidays).where(eq(holidays.date, v.date));
    if (existing) return { ok: false, error: "duplicate" };

    const holding = await tx
      .select({ id: bookings.id, reference: bookings.reference, startsAt: bookings.startsAt })
      .from(bookings)
      .where(
        and(
          notInArray(bookings.status, ["cancelled", "no_show"]),
          lt(bookings.startsAt, atMinutes(addDays(v.date, 1), 0)),
          gt(bookings.endsAt, atMinutes(v.date, 0)),
        ),
      )
      .orderBy(asc(bookings.startsAt), asc(bookings.id));
    if (holding.length > 0) return { ok: false, error: "has_bookings", bookings: holding };

    await tx.insert(holidays).values({ date: v.date, name: v.name, createdBy: actor.userId });
    await audit(tx, actor, { action: "holiday.add", entity: "holidays", entityId: v.date, details: { name: v.name } });
    return { ok: true, holiday: { date: v.date, name: v.name } };
  });
}

export type RemoveHolidayResult = { ok: true } | { ok: false; error: "validation" | "not_found" | "refused" }; // refused = a past date

/** Only a holiday dated today or later; a past one stays for the record (owner, 2026-11-26). Audited `holiday.remove`. */
export async function removeHolidayFor(actor: Actor, input: unknown): Promise<RemoveHolidayResult> {
  requireAdmin(actor);
  const parsed = removeHolidayInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const { date } = parsed.data;

  return getDb().transaction(async (tx): Promise<RemoveHolidayResult> => {
    const [row] = await tx.select().from(holidays).where(eq(holidays.date, date)).for("update");
    if (!row) return { ok: false, error: "not_found" };
    if (row.date < localDate(new Date())) return { ok: false, error: "refused" };
    await tx.delete(holidays).where(eq(holidays.date, row.date));
    await audit(tx, actor, { action: "holiday.remove", entity: "holidays", entityId: row.date, details: { name: row.name } });
    return { ok: true };
  });
}
