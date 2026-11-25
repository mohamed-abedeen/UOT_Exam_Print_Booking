// Arabic labels and display formatting for the booking screens (college and operator): one wording everywhere. Pure (no database, no `server-only`): the
// booking form (a client component) and the list page both use it. Times use the fixed +02:00 offset of
// lib/scheduling/time.ts, never Intl, so the server and the browser print the same text.
import { minutesOfDay, TZ_OFFSET_MINUTES, weekdayOf } from "@/lib/scheduling/time";
import type { BookingStatus, Refusal, ServiceType, Sides } from "@/lib/scheduling/types";

export const SERVICE_LABEL: Record<ServiceType, string> = {
  exam_questions: "أسئلة الامتحانات",
  results: "النتائج",
  quality: "الجودة",
  answer_sheets: "أوراق الإجابة",
};

export const SIDES_LABEL: Record<Sides, string> = {
  single: "وجه واحد",
  duplex: "وجهان",
};

export const STATUS_LABEL: Record<BookingStatus, string> = {
  booked: "محجوز",
  in_progress: "قيد التنفيذ",
  ready: "جاهز للاستلام",
  delivered: "تم التسليم",
  cancelled: "ملغى",
  no_show: "لم يحضر",
};

/** Why a time is not available, in words the exam office can act on. */
export const REFUSAL_LABEL: Record<Refusal, string> = {
  day_closed: "هذا اليوم مغلق (عطلة أو خارج أيام العمل)",
  past: "هذا الوقت انقضى",
  hour_full: "هذه الساعة ممتلئة",
  large_job_limit: "بلغ هذا اليوم الحد الأقصى للأعمال الكبيرة",
  saturday_quota: "الكمية تتجاوز الكمية المعتمدة لهذا اليوم",
  no_machine: "لا توجد آلة مناسبة لهذا العمل (حسب عدد الأوراق أو الطباعة على وجهين)",
  no_free_slot: "لا يوجد وقت متاح في الأيام القادمة",
  too_long: "العمل أطول من يوم عمل كامل على أسرع آلة مناسبة",
};

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits → 0-9, so a phone or a count typed on an Arabic keyboard is read. */
export function digits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 0xf));
}

const WEEKDAY_NAME = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export function weekdayName(weekday: number): string {
  return WEEKDAY_NAME[weekday] ?? "";
}

/** 'YYYY-MM-DD' → 'الأحد 2026-11-29' */
export function formatDay(date: string): string {
  return `${weekdayName(weekdayOf(date))} ${date}`;
}

/** An instant → 'YYYY-MM-DD' of the business day. */
export function dayOf(at: Date): string {
  return new Date(at.getTime() + TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** An instant → 'HH:MM' on the business clock. */
export function timeOf(at: Date): string {
  return new Date(at.getTime() + TZ_OFFSET_MINUTES * 60_000).toISOString().slice(11, 16);
}

/**
 * The start hours the form offers: every hour that holds at least one working minute.
 * 09:00–15:00 → 9…14; 09:30–14:30 → 9…14.
 */
export function startHours(workStart: string, workEnd: string): number[] {
  const first = Math.floor(minutesOfDay(workStart) / 60);
  const last = Math.ceil(minutesOfDay(workEnd) / 60) - 1;
  const hours: number[] = [];
  for (let h = first; h <= last; h++) hours.push(h);
  return hours;
}

/** 9 → '09:00' */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}
