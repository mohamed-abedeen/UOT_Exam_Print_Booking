"use client";
// The admin's settings screen (step 2.7, contracts §4 "Settings and holidays", §5): one form for the nine keys (Save
// sends only the keys that changed, all saved or none) and the holidays (list, add, remove). Changing hours or
// weekdays never moves existing bookings; a holiday is refused while its date has bookings, and the answer lists them.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { button, buttonPrimary, errorText, field, td, th } from "@/components/admin/styles";
import { addHoliday, removeHoliday, updateSettings } from "@/lib/actions/settings";
import { dayTime, formatDay, weekdayName } from "@/lib/bookings/format";
import type { Settings } from "@/lib/scheduling/types";
import type { HolidayBooking, HolidayItem } from "@/lib/settings";
import { draftOf, NUMBER_FIELDS, settingsPatch, type SettingsDraft } from "@/lib/settings/form";

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const noticeClass =
  "notice notice--ok";
const hintClass = "text-sm text-muted-foreground";

const ADD_ERROR: Record<string, string> = {
  validation: "تحقق من التاريخ (اليوم أو بعده) ومن الاسم (من 1 إلى 200 حرف).",
  duplicate: "هذا اليوم مسجل عطلة من قبل.",
};
const REMOVE_ERROR: Record<string, string> = {
  validation: "تعذّر قراءة التاريخ.",
  not_found: "العطلة غير موجودة (ربما حُذفت من قبل).",
  refused: "لا تُحذف عطلة مضى يومها.",
};

function SettingsForm({ settings }: { settings: Settings }) {
  const [saved, setSaved] = useState(settings);
  const [draft, setDraft] = useState<SettingsDraft>(() => draftOf(settings));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function save() {
    setNotice(null);
    const result = settingsPatch(saved, draft);
    if (!result.ok) return setError(result.message);
    if (Object.keys(result.patch).length === 0) {
      setError(null);
      return setNotice("لا تغيير للحفظ.");
    }
    setError(null);
    startTransition(async () => {
      const r = await updateSettings(result.patch);
      if (!r.ok) return setError("رفض الخادم القيم: وقت النهاية بعد البداية، وأرقام صحيحة ضمن الحدود.");
      setSaved(r.settings);
      setDraft(draftOf(r.settings));
      setNotice("حُفظت الإعدادات. لا تتحرك الحجوزات الموجودة بتغيير الساعات أو الأيام.");
    });
  }

  function toggleDay(day: number) {
    setDraft((d) => ({
      ...d,
      workingWeekdays: d.workingWeekdays.includes(day)
        ? d.workingWeekdays.filter((x) => x !== day)
        : [...d.workingWeekdays, day].sort((a, b) => a - b),
    }));
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="mb-10 flex max-w-2xl flex-col gap-5">
      <h2 className="text-[15px] font-bold">الدوام والقواعد</h2>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">ساعات الدوام</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2">
            <span>من</span>
            <input
              type="time"
              step={600}
              value={draft.workStart}
              onChange={(e) => setDraft({ ...draft, workStart: e.target.value })}
              dir="ltr"
              required
              className={field}
            />
          </label>
          <label className="flex items-center gap-2">
            <span>إلى</span>
            <input
              type="time"
              step={600}
              value={draft.workEnd}
              onChange={(e) => setDraft({ ...draft, workEnd: e.target.value })}
              dir="ltr"
              required
              className={field}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">أيام الدوام</legend>
        <div className="flex flex-wrap gap-4">
          {WEEKDAYS.map((day) => (
            <label key={day} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.workingWeekdays.includes(day)}
                onChange={() => toggleDay(day)}
              />
              <span>{weekdayName(day)}</span>
            </label>
          ))}
        </div>
        <p className={hintClass}>إن فُتح السبت هنا لم تعد الكليات تحتاج طلب سبت.</p>
      </fieldset>

      {NUMBER_FIELDS.map((f) => (
        <label key={f.key} className="flex flex-col gap-1">
          <span className="text-sm font-medium">{f.label}</span>
          <input
            value={draft[f.key]}
            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            inputMode="numeric"
            dir="ltr"
            required
            maxLength={10}
            className={`${field} w-40 text-left`}
          />
          <span className={hintClass}>{f.hint}</span>
        </label>
      ))}

      {error && (
        <p role="alert" className={errorText}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={noticeClass}>
          {notice}
        </p>
      )}
      <div>
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "جارٍ الحفظ…" : "حفظ الإعدادات"}
        </button>
      </div>
    </form>
  );
}

function HolidayForm({ today }: { today: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<HolidayBooking[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit() {
    setError(null);
    setBlocking(null);
    setNotice(null);
    if (date < today || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError(ADD_ERROR.validation);
    if (name.trim() === "") return setError(ADD_ERROR.validation);
    startTransition(async () => {
      const r = await addHoliday({ date, name });
      if (r.ok) {
        router.refresh();
        setNotice(`سُجّلت العطلة: ${formatDay(r.holiday.date)} — ${r.holiday.name}.`);
        setDate("");
        setName("");
      } else if (r.error === "has_bookings") {
        setError("لا يمكن إعلان العطلة: على هذا اليوم حجوزات. حرّكها أو ألغها أولاً، ثم أعد المحاولة:");
        setBlocking(r.bookings);
      } else {
        setError(ADD_ERROR[r.error]);
      }
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="mb-6 flex max-w-2xl flex-col gap-3 rounded-2xl border border-border p-4 bg-card">
      <h3 className="font-bold">إضافة عطلة</h3>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">التاريخ</span>
          <input
            type="date"
            value={date}
            min={today}
            onChange={(e) => setDate(e.target.value)}
            dir="ltr"
            required
            className={field}
          />
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className="text-sm font-medium">الاسم</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
            className={field}
          />
        </label>
      </div>
      {error && (
        <div role="alert" className={errorText}>
          <p>{error}</p>
          {blocking && (
            <ul className="mt-1 list-disc ps-5">
              {blocking.map((b) => (
                <li key={b.id}>
                  <span dir="ltr">{b.reference}</span> — {dayTime(b.startsAt)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className={noticeClass}>
          {notice}
        </p>
      )}
      <div>
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "جارٍ الحفظ…" : "أضف العطلة"}
        </button>
      </div>
    </form>
  );
}

function HolidayRow({ holiday, today }: { holiday: HolidayItem; today: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const past = holiday.date < today;

  function remove() {
    setError(null);
    startTransition(async () => {
      const r = await removeHoliday({ date: holiday.date });
      if (!r.ok) setError(REMOVE_ERROR[r.error]);
      router.refresh();
    });
  }

  return (
    <tr>
      <td className={`${td} whitespace-nowrap`}>{formatDay(holiday.date)}</td>
      <td className={td}>{holiday.name}</td>
      <td className={td}>
        {holiday.createdByName} · {dayTime(holiday.createdAt)}
      </td>
      <td className={`${td} whitespace-nowrap`}>
        {past ? (
          <span className={hintClass}>مضى يومها</span>
        ) : (
          <button type="button" disabled={pending} onClick={remove} className={button}>
            {pending ? "جارٍ الحذف…" : "احذف"}
          </button>
        )}
        {error && (
          <span role="alert" className={`block ${errorText}`}>
            {error}
          </span>
        )}
      </td>
    </tr>
  );
}

export function SettingsManager({
  settings,
  holidays,
  today,
}: {
  settings: Settings;
  holidays: HolidayItem[];
  today: string;
}) {
  return (
    <section>
      <h1 className="mb-1 text-xl font-bold md:text-2xl">الإعدادات</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        تغيير الساعات أو الأيام لا يحرّك الحجوزات الموجودة.
      </p>

      <SettingsForm settings={settings} />

      <h2 className="mb-3 text-[15px] font-bold">العطل</h2>
      <HolidayForm today={today} />
      {holidays.length === 0 ? (
        <p className="rounded-2xl border border-dashed bg-card px-6 py-14 text-center text-muted-foreground">لا توجد عطل مسجلة.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>اليوم</th>
                <th className={th}>الاسم</th>
                <th className={th}>سجّلها</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {holidays.map((h) => (
                <HolidayRow key={h.date} holiday={h} today={today} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
