// Client-safe check of a Saturday request's date (step 2.7). It mirrors the first rules of `createSaturdayRequestFor`
// (lib/saturday/index.ts) so the form can answer at once; a holiday is known only to the server, which stays the
// authority. Pure: no database, no `server-only`.
import { weekdayOf } from "@/lib/scheduling/time";

const SATURDAY = 6;

export type SaturdayDateIssue = "not_saturday" | "not_future" | "working_day";

/** `null` = the date may be sent. `today` and `date` are 'YYYY-MM-DD' on the business clock. */
export function saturdayDateIssue(date: string, today: string, workingWeekdays: readonly number[]): SaturdayDateIssue | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || weekdayOf(date) !== SATURDAY) return "not_saturday";
  if (date <= today) return "not_future";
  if (workingWeekdays.includes(SATURDAY)) return "working_day";
  return null;
}
