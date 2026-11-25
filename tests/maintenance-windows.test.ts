// Step 2.5 — what a maintenance row means now, and the labels of the new screens. Pure: no database.
import { describe, expect, it } from "vitest";
import { durationText, MOVE_REFUSAL_LABEL, RESCHEDULE_REASON_LABEL } from "@/lib/bookings/format";
import { isOpenWindow, windowState } from "@/lib/maintenance/windows";

const at = (iso: string) => new Date(`2026-11-29T${iso}:00+02:00`);
const NOW = at("10:00");

describe("windowState", () => {
  it("a window that began and has no end is active, one that starts later is planned", () => {
    expect(windowState({ startsAt: at("09:00"), endsAt: null, endedAt: null }, NOW)).toBe("active");
    expect(windowState({ startsAt: at("09:00"), endsAt: at("12:00"), endedAt: null }, NOW)).toBe("active");
    expect(windowState({ startsAt: at("11:00"), endsAt: at("12:00"), endedAt: null }, NOW)).toBe("planned");
    expect(windowState({ startsAt: at("11:00"), endsAt: null, endedAt: null }, NOW)).toBe("planned");
  });

  it("a window starting exactly now is active; one ending exactly now is over", () => {
    expect(windowState({ startsAt: NOW, endsAt: null, endedAt: null }, NOW)).toBe("active");
    expect(windowState({ startsAt: at("08:00"), endsAt: NOW, endedAt: null }, NOW)).toBe("over");
  });

  it("an admin's reactivation is 'ended'; a window cancelled before it began (ends_at = starts_at) is 'cancelled'", () => {
    expect(windowState({ startsAt: at("08:00"), endsAt: at("09:30"), endedAt: at("09:30") }, NOW)).toBe("ended");
    expect(windowState({ startsAt: at("11:00"), endsAt: at("11:00"), endedAt: at("09:00") }, NOW)).toBe("cancelled");
  });

  it("only active and planned windows are open (the ones the reactivate button can close)", () => {
    expect(isOpenWindow("active")).toBe(true);
    expect(isOpenWindow("planned")).toBe(true);
    for (const state of ["over", "ended", "cancelled"] as const) expect(isOpenWindow(state)).toBe(false);
  });
});

describe("labels of the 2.5 screens", () => {
  it("every move refusal and every reschedule reason has a text", () => {
    for (const reason of ["not_eligible", "past", "day_closed", "outside_hours", "large_job_limit", "saturday_quota", "busy"] as const) {
      expect(MOVE_REFUSAL_LABEL[reason].length).toBeGreaterThan(0);
    }
    for (const reason of ["maintenance", "delay_no_slot", "machine_change"] as const) {
      expect(RESCHEDULE_REASON_LABEL[reason].length).toBeGreaterThan(0);
    }
  });

  it("durationText: minutes, whole hours, hours and minutes", () => {
    expect(durationText(45)).toBe("45 د");
    expect(durationText(120)).toBe("2 س");
    expect(durationText(90)).toBe("1 س 30 د");
    expect(durationText(0)).toBe("0 د");
  });
});
