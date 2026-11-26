// Step 2.7 — the browser-side check of the settings form and the patch it sends. Pure: no database.
import { describe, expect, it } from "vitest";
import type { Settings } from "@/lib/scheduling/types";
import { draftOf, settingsPatch } from "@/lib/settings/form";

const CURRENT: Settings = {
  workStart: "09:00",
  workEnd: "15:00",
  workingWeekdays: [0, 1, 2, 3, 4],
  largeJobThreshold: 6000,
  largeJobsPerDay: 2,
  editDeadlineMinutes: 60,
  delayDeadlineMinutes: 60,
  suggestionSearchDays: 14,
  partWarnPercent: 90,
};

function patchOf(change: Partial<ReturnType<typeof draftOf>>) {
  return settingsPatch(CURRENT, { ...draftOf(CURRENT), ...change });
}

describe("settingsPatch", () => {
  it("an untouched form gives an empty patch", () => {
    expect(settingsPatch(CURRENT, draftOf(CURRENT))).toEqual({ ok: true, patch: {} });
  });

  it("only the keys that changed are sent", () => {
    expect(patchOf({ workEnd: "14:30", largeJobThreshold: "8000" })).toEqual({
      ok: true,
      patch: { workEnd: "14:30", largeJobThreshold: 8000 },
    });
  });

  it("weekdays: order does not matter, a new day is a change", () => {
    expect(patchOf({ workingWeekdays: [4, 3, 2, 1, 0] })).toEqual({ ok: true, patch: {} });
    expect(patchOf({ workingWeekdays: [0, 1, 2, 3, 4, 6] })).toEqual({
      ok: true,
      patch: { workingWeekdays: [0, 1, 2, 3, 4, 6] },
    });
  });

  it("no working weekday is refused", () => {
    expect(patchOf({ workingWeekdays: [] }).ok).toBe(false);
  });

  it("hours: the end must be after the start, both on the 10-minute grid", () => {
    expect(patchOf({ workStart: "15:00" }).ok).toBe(false);
    expect(patchOf({ workEnd: "09:00" }).ok).toBe(false);
    expect(patchOf({ workStart: "09:05" }).ok).toBe(false);
    expect(patchOf({ workStart: "" }).ok).toBe(false);
    expect(patchOf({ workStart: "08:30", workEnd: "16:10" }).ok).toBe(true);
  });

  it("numbers typed with Arabic-Indic digits are read", () => {
    expect(patchOf({ editDeadlineMinutes: "٩٠" })).toEqual({ ok: true, patch: { editDeadlineMinutes: 90 } });
  });

  it("each number field keeps its bounds (contracts §5)", () => {
    expect(patchOf({ largeJobThreshold: "0" }).ok).toBe(false); // ≥ 1
    expect(patchOf({ largeJobsPerDay: "0" }).ok).toBe(true); // ≥ 0
    expect(patchOf({ editDeadlineMinutes: "-1" }).ok).toBe(false);
    expect(patchOf({ delayDeadlineMinutes: "0" }).ok).toBe(true);
    expect(patchOf({ suggestionSearchDays: "0" }).ok).toBe(false);
    expect(patchOf({ suggestionSearchDays: "60" }).ok).toBe(true);
    expect(patchOf({ suggestionSearchDays: "61" }).ok).toBe(false);
    expect(patchOf({ partWarnPercent: "0" }).ok).toBe(false);
    expect(patchOf({ partWarnPercent: "100" }).ok).toBe(true);
    expect(patchOf({ partWarnPercent: "101" }).ok).toBe(false);
  });

  it("empty, decimal or text numbers are refused with the field's name", () => {
    for (const bad of ["", "1.5", "abc", "12 3"]) {
      const r = patchOf({ largeJobThreshold: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("حد الطلب الكبير");
    }
  });
});
