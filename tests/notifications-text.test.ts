// Step 2.2 — the Arabic text of a notification: every type has one, booking data fills it, bad data does not break it.
import { describe, expect, it } from "vitest";
import { notificationType } from "@/db/schema";
import { notificationText } from "@/lib/notifications/text";

// Sunday 2026-11-29, 09:00–10:00 Tripoli time (+02:00).
const data = { reference: "2026-0007", startsAt: "2026-11-29T07:00:00.000Z", endsAt: "2026-11-29T08:00:00.000Z" };

describe("step 2.2: notificationText", () => {
  it("has a text for every notification type, with and without data", () => {
    for (const type of notificationType.enumValues) {
      expect(notificationText(type, data).length).toBeGreaterThan(0);
      expect(notificationText(type, {}).length).toBeGreaterThan(0);
      expect(notificationText(type, null).length).toBeGreaterThan(0);
    }
  });

  it("ready names the booking; no-show and on-behalf add the day and the times", () => {
    expect(notificationText("booking_ready", data)).toBe("الحجز ⁦2026-0007⁩ جاهز للاستلام.");
    expect(notificationText("booking_no_show", data)).toBe(
      "سُجّل عدم حضور الحجز ⁦2026-0007⁩ (الأحد 2026-11-29، من 09:00 إلى 10:00) وتم تحرير الوقت.",
    );
    expect(notificationText("booking_on_behalf", data)).toContain("من 09:00 إلى 10:00");
  });

  it("data that is not the booking shape gives a text without the reference or the time", () => {
    expect(notificationText("booking_ready", { reference: 7 })).toBe("الحجز جاهز للاستلام.");
    expect(notificationText("booking_no_show", { ...data, startsAt: "not a date" })).toBe(
      "سُجّل عدم حضور الحجز وتم تحرير الوقت.",
    );
  });
});
