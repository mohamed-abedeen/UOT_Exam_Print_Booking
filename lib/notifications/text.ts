// The Arabic text of a notification (contracts §6, owner 2026-11-25: the table keeps `type` + `data`, the text is made
// here). Pure — the bell, a client component, uses it. A row whose `data` is not the booking shape still gets a text.
import { dayOf, formatDay, timeOf } from "@/lib/bookings/format";
import type { NotificationType } from "@/lib/notifications";

interface BookingShape {
  reference: string;
  start: Date;
  end: Date;
}

function readBooking(data: unknown): BookingShape | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.reference !== "string" || typeof d.startsAt !== "string" || typeof d.endsAt !== "string") return null;
  const start = new Date(d.startsAt);
  const end = new Date(d.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { reference: d.reference, start, end };
}

/** Keeps '2026-0001' in one left-to-right run inside Arabic text. */
const ltr = (s: string) => `⁦${s}⁩`;

export function notificationText(type: NotificationType, data: unknown): string {
  const b = readBooking(data);
  const job = b ? `الحجز ${ltr(b.reference)}` : "الحجز";
  const when = b ? ` (${formatDay(dayOf(b.start))}، من ${timeOf(b.start)} إلى ${timeOf(b.end)})` : "";
  switch (type) {
    case "booking_ready":
      return `${job} جاهز للاستلام.`;
    case "booking_no_show":
      return `سُجّل عدم حضور ${job}${when} وتم تحرير الوقت.`;
    case "booking_on_behalf":
      return `أنشأ المسؤول ${job} باسم كليتكم${when}.`;
    case "booking_needs_reschedule":
      return `${job} يحتاج إعادة جدولة.`;
    case "booking_rescheduled":
      return `نُقل ${job} إلى موعد جديد${when}.`;
    case "booking_restored":
      return `عاد ${job} إلى موعده${when}.`;
    case "booking_cancelled":
      return `ألغى المسؤول ${job}.`;
    case "saturday_requested":
      return "وصل طلب جديد ليوم السبت.";
    case "saturday_decided":
      return "تم البتّ في طلب يوم السبت.";
  }
}
