// Step 2.7 — the settings form: what is typed → the patch `updateSettings` takes (contracts §4, §5). Pure, no database,
// so the browser can refuse a bad value before the round trip and a test can run it. The server checks again.
import { digits } from "@/lib/bookings/format";
import type { Settings } from "@/lib/scheduling/types";

/** The form's state: times as typed ('HH:MM'), numbers as text, weekdays as a set of 0–6. */
export interface SettingsDraft {
  workStart: string;
  workEnd: string;
  workingWeekdays: number[];
  largeJobThreshold: string;
  largeJobsPerDay: string;
  editDeadlineMinutes: string;
  delayDeadlineMinutes: string;
  suggestionSearchDays: string;
  partWarnPercent: string;
}

type NumberKey = Exclude<keyof Settings, "workStart" | "workEnd" | "workingWeekdays">;

/** The whole-number fields with their bounds (contracts §5) and their Arabic labels. */
export const NUMBER_FIELDS: { key: NumberKey; label: string; hint: string; min: number; max: number }[] = [
  {
    key: "largeJobThreshold",
    label: "حد الطلب الكبير (أوجه مطبوعة)",
    hint: "الطلب كبير إذا زاد عدد أوجهه المطبوعة على هذا الرقم.",
    min: 1,
    max: 2_147_483_647,
  },
  {
    key: "largeJobsPerDay",
    label: "عدد الطلبات الكبيرة في اليوم",
    hint: "لكل الكليات والآلات معاً؛ 0 يمنع الطلبات الكبيرة.",
    min: 0,
    max: 2_147_483_647,
  },
  {
    key: "editDeadlineMinutes",
    label: "آخر موعد للتعديل أو الإلغاء (دقائق قبل البدء)",
    hint: "بعده لا تعدّل الكلية الحجز ولا تلغيه.",
    min: 0,
    max: 2_147_483_647,
  },
  {
    key: "delayDeadlineMinutes",
    label: "آخر موعد لإشعار التأخير (دقائق قبل البدء)",
    hint: "بعده لا يُقبل إشعار التأخير.",
    min: 0,
    max: 2_147_483_647,
  },
  {
    key: "suggestionSearchDays",
    label: "أيام البحث عن أقرب موعد",
    hint: "من 1 إلى 60.",
    min: 1,
    max: 60,
  },
  {
    key: "partWarnPercent",
    label: "نسبة تنبيه القطعة من عمرها (%)",
    hint: "من 1 إلى 100.",
    min: 1,
    max: 100,
  },
];

export function draftOf(s: Settings): SettingsDraft {
  return {
    workStart: s.workStart,
    workEnd: s.workEnd,
    workingWeekdays: [...s.workingWeekdays].sort((a, b) => a - b),
    largeJobThreshold: String(s.largeJobThreshold),
    largeJobsPerDay: String(s.largeJobsPerDay),
    editDeadlineMinutes: String(s.editDeadlineMinutes),
    delayDeadlineMinutes: String(s.delayDeadlineMinutes),
    suggestionSearchDays: String(s.suggestionSearchDays),
    partWarnPercent: String(s.partWarnPercent),
  };
}

const GRID_TIME = /^([01]\d|2[0-3]):[0-5]0$/; // HH:MM on the 10-minute grid

export type PatchResult = { ok: true; patch: Partial<Settings> } | { ok: false; message: string };

/**
 * The keys that differ from `current`, as a patch; `{ ok: true, patch: {} }` when nothing changed. A bad value gives the
 * first problem in Arabic. Hours are checked as a pair, weekdays as a non-empty set.
 */
export function settingsPatch(current: Settings, draft: SettingsDraft): PatchResult {
  const patch: Partial<Settings> = {};

  const start = digits(draft.workStart).trim();
  const end = digits(draft.workEnd).trim();
  if (!GRID_TIME.test(start) || !GRID_TIME.test(end)) {
    return { ok: false, message: "ساعات الدوام: اكتب الوقت بالساعة والدقيقة على شبكة 10 دقائق (مثل 09:00 أو 14:30)." };
  }
  if (end <= start) return { ok: false, message: "وقت نهاية الدوام يجب أن يكون بعد وقت بدايته." };
  if (start !== current.workStart) patch.workStart = start;
  if (end !== current.workEnd) patch.workEnd = end;

  const days = [...new Set(draft.workingWeekdays)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (days.length === 0) return { ok: false, message: "اختر يوم دوام واحداً على الأقل." };
  days.sort((a, b) => a - b);
  if (JSON.stringify(days) !== JSON.stringify([...current.workingWeekdays].sort((a, b) => a - b))) {
    patch.workingWeekdays = days;
  }

  for (const f of NUMBER_FIELDS) {
    const text = digits(draft[f.key]).trim();
    const value = /^\d{1,10}$/.test(text) ? Number(text) : Number.NaN;
    if (!(Number.isInteger(value) && value >= f.min && value <= f.max)) {
      const range = f.max === 2_147_483_647 ? `عدد صحيح من ${f.min} فأكثر` : `عدد صحيح من ${f.min} إلى ${f.max}`;
      return { ok: false, message: `«${f.label}»: ${range}.` };
    }
    if (value !== current[f.key]) patch[f.key] = value;
  }
  return { ok: true, patch };
}
