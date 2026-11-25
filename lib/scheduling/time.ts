// Business time (contracts §0): Africa/Tripoli is UTC+2 with no DST, held here as one fixed offset
// (owner, 2026-11-25). A date is 'YYYY-MM-DD' and a time of day is 'HH:MM', both in that zone.

export const SLOT_MINUTES = 10;
export const TZ_OFFSET_MINUTES = 120;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SLOT_MS = SLOT_MINUTES * MINUTE_MS;

/** UTC midnight of the calendar date: a day counter, not a business instant. */
function dayNumberMs(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** '09:30' → 570 */
export function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/** The instant that is `minutes` after local midnight of `date`. */
export function atMinutes(date: string, minutes: number): Date {
  return new Date(dayNumberMs(date) + (minutes - TZ_OFFSET_MINUTES) * MINUTE_MS);
}

/** The business date of an instant. */
export function localDate(at: Date): string {
  return new Date(at.getTime() + TZ_OFFSET_MINUTES * MINUTE_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday */
export function weekdayOf(date: string): number {
  return new Date(dayNumberMs(date)).getUTCDay();
}

export function addDays(date: string, days: number): string {
  return new Date(dayNumberMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MINUTE_MS);
}

/** Rounds up to the 10-minute grid; an instant already on it stays. */
export function ceilToGrid(at: Date): Date {
  const ms = at.getTime();
  const over = ms % SLOT_MS;
  return over === 0 ? at : new Date(ms - over + SLOT_MS);
}
