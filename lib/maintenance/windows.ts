// What a maintenance row means right now (contracts §3.8). Pure and client-safe: the maintenance screen uses it
// to tell a running stop from a planned one, and a finished row from one that was cancelled before it began.

export interface WindowTimes {
  startsAt: Date;
  endsAt: Date | null; // null = open until reactivated
  endedAt: Date | null; // set when an admin reactivated the machine or cancelled the window
}

/**
 * - `active`: the machine is stopped now (started, not over, not ended);
 * - `planned`: starts later;
 * - `over`: its `endsAt` has passed on its own;
 * - `ended`: an admin reactivated the machine (`endsAt` was moved to that moment);
 * - `cancelled`: an admin cancelled it before it started (`endsAt = startsAt`, §3.8 `endMaintenance`).
 */
export type WindowState = "active" | "planned" | "over" | "ended" | "cancelled";

export function windowState(w: WindowTimes, now: Date): WindowState {
  if (w.endedAt !== null) return w.endsAt !== null && w.endsAt.getTime() === w.startsAt.getTime() ? "cancelled" : "ended";
  if (w.endsAt !== null && w.endsAt.getTime() <= now.getTime()) return "over";
  return w.startsAt.getTime() <= now.getTime() ? "active" : "planned";
}

/** A window that still matters: running now or planned. These are the ones `endMaintenance` can close. */
export function isOpenWindow(state: WindowState): boolean {
  return state === "active" || state === "planned";
}
