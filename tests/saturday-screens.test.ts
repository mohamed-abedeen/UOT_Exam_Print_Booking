// Step 2.7 — the browser-side checks of the Saturday request form and its labels. Pure: no database.
import { describe, expect, it } from "vitest";
import { SATURDAY_STATUS_LABEL, SATURDAY_STATUS_TONE } from "@/lib/bookings/format";
import { saturdayDateIssue } from "@/lib/saturday/dates";

const WEEK = [0, 1, 2, 3, 4]; // Sunday–Thursday
const TODAY = "2026-11-25"; // a Wednesday

describe("saturdayDateIssue", () => {
  it("a Saturday after today is fine", () => {
    expect(saturdayDateIssue("2026-11-28", TODAY, WEEK)).toBeNull();
    expect(saturdayDateIssue("2026-12-05", TODAY, WEEK)).toBeNull();
  });

  it("today and the past are refused, even on a Saturday (the server needs a date after today)", () => {
    expect(saturdayDateIssue("2026-11-28", "2026-11-28", WEEK)).toBe("not_future");
    expect(saturdayDateIssue("2026-11-21", TODAY, WEEK)).toBe("not_future");
  });

  it("another weekday or a half-typed date is not a Saturday", () => {
    expect(saturdayDateIssue("2026-11-29", TODAY, WEEK)).toBe("not_saturday"); // Sunday
    expect(saturdayDateIssue("2026-11-27", TODAY, WEEK)).toBe("not_saturday"); // Friday
    expect(saturdayDateIssue("2026-11-2", TODAY, WEEK)).toBe("not_saturday");
    expect(saturdayDateIssue("", TODAY, WEEK)).toBe("not_saturday");
  });

  it("when Saturday is a working weekday no request is needed", () => {
    expect(saturdayDateIssue("2026-11-28", TODAY, [...WEEK, 6])).toBe("working_day");
  });
});

describe("Saturday status labels", () => {
  it("every status has a label and a tone", () => {
    for (const status of ["pending", "approved", "rejected"] as const) {
      expect(SATURDAY_STATUS_LABEL[status]).not.toBe("");
      expect(SATURDAY_STATUS_TONE[status]).not.toBe("");
    }
  });
});
