"use client";
// The college's booking form (plan §4 "Booking form"). Everything is checked here first for a quick answer and
// again on the server (createBooking is the authority). Availability is asked live: each change of the job, the
// day or the hour asks `getAvailability` again after a short pause, and the answer is the exact time, the nearest
// free time (accepted by pressing the button), or the reason there is none.
// With `edit` the same form changes an existing booking (step 2.5): it starts from the booking's values, asks the
// availability with the booking's id (its own interval does not count as busy) and saves with `editBooking`.
// With `onBehalf` (step 2.7) an admin books for a college they pick: the college goes with every availability
// question and with the booking, and a success stays on the page and shows the reference.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { createBooking, editBooking, getAvailability } from "@/lib/actions/bookings";
import {
  dayOf,
  digits,
  formatDay,
  hourLabel,
  REFUSAL_LABEL,
  SERVICE_LABEL,
  SIDES_LABEL,
  startHours,
  timeOf,
  weekdayName,
} from "@/lib/bookings/format";
import type { BookingFormConfig } from "@/lib/bookings/read";
import type { Availability } from "@/lib/scheduling/availability";
import { examDateWarning, isFourPartName, normalizePhone } from "@/lib/scheduling/helpers";
import type { ServiceType, Sides } from "@/lib/scheduling/types";

const CHECK_DELAY_MS = 350;

const control =
  "w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-base dark:border-zinc-700 aria-[invalid=true]:border-red-600";

export interface Fields {
  doctorName: string;
  doctorPhone: string;
  recipientName: string;
  subject: string;
  serviceType: ServiceType;
  copies: string;
  models: string;
  pagesPerModel: string;
  sides: Sides;
  examDate: string;
  date: string;
  hour: string;
}

const EMPTY: Fields = {
  doctorName: "",
  doctorPhone: "",
  recipientName: "",
  subject: "",
  serviceType: "exam_questions",
  copies: "",
  models: "1",
  pagesPerModel: "",
  sides: "single",
  examDate: "",
  date: "",
  hour: "",
};

/** The text of a whole-number field as a number, or NaN. Arabic-Indic digits are accepted. */
function whole(text: string): number {
  const s = digits(text).trim();
  return /^\d{1,9}$/.test(s) ? Number(s) : Number.NaN;
}
const within = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

type Answer = { key: string; availability: Availability | null }; // null = the server refused the input

/** The booking being changed and the form's starting values. */
export interface EditTarget {
  bookingId: number;
  initial: Fields;
  /** The booking's interval now: shown, and kept, while the job, the day and the hour are not changed. */
  slot: { startsAt: Date; endsAt: Date };
}

/** The admin's mode: the colleges to pick from. */
export interface OnBehalf {
  colleges: { id: number; name: string }[];
}

type Booked = { reference: string; collegeName: string; examWarning: boolean };

export function BookingForm({
  config,
  edit,
  onBehalf,
}: {
  config: BookingFormConfig;
  edit?: EditTarget;
  onBehalf?: OnBehalf;
}) {
  const router = useRouter();
  const [f, setF] = useState<Fields>(edit?.initial ?? EMPTY);
  const [touched, setTouched] = useState<ReadonlySet<keyof Fields>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [collegeId, setCollegeId] = useState("");
  const [booked, setBooked] = useState<Booked | null>(null);

  const hours = useMemo(() => startHours(config.workStart, config.workEnd), [config.workStart, config.workEnd]);
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setF((prev) => ({ ...prev, [key]: value }));
  const touch = (key: keyof Fields) => setTouched((prev) => new Set(prev).add(key));

  // ---- field checks
  const phone = normalizePhone(digits(f.doctorPhone));
  const copies = whole(f.copies);
  const models = whole(f.models);
  const pages = whole(f.pagesPerModel);
  const hour = f.hour === "" ? Number.NaN : Number(f.hour);
  // An edit that leaves the job, the day and the hour alone keeps its placement on the server (contracts §3.7: a
  // plain update), so nothing is asked and the day and hour are not checked again (step 2.8).
  const kept =
    edit !== undefined &&
    copies === whole(edit.initial.copies) &&
    models === whole(edit.initial.models) &&
    pages === whole(edit.initial.pagesPerModel) &&
    f.sides === edit.initial.sides &&
    f.date === edit.initial.date &&
    f.hour === edit.initial.hour;
  const errors: Partial<Record<keyof Fields, string>> = {};
  if (f.doctorName.trim() === "") errors.doctorName = "أدخل اسم الدكتور";
  if (phone === null) errors.doctorPhone = "رقم الهاتف غير صالح، مثال: 0912345678";
  if (!isFourPartName(f.recipientName)) errors.recipientName = "أدخل اسم المستلم رباعيًا (أربع كلمات على الأقل)";
  if (f.subject.trim() === "") errors.subject = "أدخل المادة";
  if (!within(copies, 1, 20_000)) errors.copies = "عدد النسخ من 1 إلى 20000";
  if (!within(models, 1, 50)) errors.models = "عدد النماذج من 1 إلى 50";
  if (!within(pages, 1, 500)) errors.pagesPerModel = "عدد الصفحات من 1 إلى 500";
  if (!kept) {
    if (!isDate(f.date)) errors.date = "اختر اليوم";
    else if (f.date < config.today) errors.date = "لا يمكن الحجز في يوم مضى";
    if (!hours.includes(hour)) errors.hour = "اختر الساعة";
  }
  if (f.examDate !== "" && !isDate(f.examDate)) errors.examDate = "تاريخ غير صالح";
  const shown = (key: keyof Fields) => (touched.has(key) || attempted ? errors[key] : undefined);
  const collegeError = onBehalf && collegeId === "" ? "اختر الكلية" : undefined;

  // ---- live availability
  const ready =
    !errors.copies && !errors.models && !errors.pagesPerModel && !errors.date && !errors.hour && !collegeError;
  const query = ready
    ? {
        copies,
        models,
        pagesPerModel: pages,
        sides: f.sides,
        date: f.date,
        hour,
        ...(onBehalf ? { collegeId: Number(collegeId) } : {}),
      }
    : null;
  const queryKey = query && !kept ? JSON.stringify(edit ? { ...query, bookingId: edit.bookingId } : query) : null;

  useEffect(() => {
    if (!queryKey) return;
    let stale = false;
    const timer = setTimeout(async () => {
      const result = await getAvailability(JSON.parse(queryKey));
      if (!stale) setAnswer({ key: queryKey, availability: result.ok ? result.availability : null });
    }, CHECK_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [queryKey]);

  const current = answer && answer.key === queryKey ? answer : null; // an answer to older input is not shown
  const availability = current?.availability ?? null;
  const checking = queryKey !== null && current === null;

  // ---- the exam-date warning looks at the day the booking would really land on
  const landingDay = availability?.kind === "suggestion" ? dayOf(availability.placement.startsAt) : f.date;
  const examWarning = isDate(landingDay) && isDate(f.examDate) && examDateWarning(landingDay, f.examDate);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    setNotice(null);
    setBooked(null);
    if (Object.keys(errors).length > 0 || collegeError) {
      // Take the user to the first field with a message; the messages appear after this render.
      const form = event.currentTarget;
      setTimeout(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    if (!query) return;
    if (!kept && (!availability || availability.kind === "none")) return;

    setSubmitting(true);
    let redirecting = false;
    try {
      const accept =
        availability?.kind === "suggestion"
          ? { machineId: availability.placement.machineId, startsAt: availability.placement.startsAt }
          : undefined;
      const payload = {
        doctorName: f.doctorName,
        doctorPhone: digits(f.doctorPhone),
        recipientName: f.recipientName,
        subject: f.subject,
        serviceType: f.serviceType,
        ...query,
        examDate: f.examDate === "" ? null : f.examDate,
        ...(accept ? { accept } : {}),
      };
      const result = edit ? await editBooking({ ...payload, bookingId: edit.bookingId }) : await createBooking(payload);
      if (result.ok && onBehalf) {
        // Stay on the page: the admin books for several colleges in a row. The college stays chosen.
        const college = onBehalf.colleges.find((c) => c.id === Number(collegeId));
        setBooked({
          reference: result.booking.reference,
          collegeName: college?.name ?? "",
          examWarning: result.examDateWarning,
        });
        setF(EMPTY);
        setTouched(new Set());
        setAttempted(false);
        setAnswer(null);
        window.scrollTo({ top: 0, behavior: "smooth" }); // the banner is at the top
        return;
      }
      if (result.ok) {
        const flag = result.examDateWarning ? "&examWarning=1" : "";
        const param = edit ? "edited" : "booked";
        redirecting = true; // stay in the "submitting" state until the page changes: no second press
        router.push(`/college?${param}=${encodeURIComponent(result.booking.reference)}${flag}`);
        return;
      }
      if (result.availability && queryKey) setAnswer({ key: queryKey, availability: result.availability });
      setNotice(
        result.error === "slot_taken"
          ? "تم حجز هذا الموعد قبل لحظات. راجع الموعد الظاهر أدناه."
          : result.error === "not_editable"
            ? "لم يعد تعديل هذا الحجز ممكنًا: انتهت مهلة التعديل أو تغيّرت حالته."
            : result.error === "not_found"
              ? "الحجز غير موجود."
              : result.error === "validation"
                ? `تعذّر ${edit ? "الحفظ" : "الحجز"}. راجع البيانات، وقد يكون حساب الكلية موقوفًا.`
                : "تغيّر التوفر. راجع الموعد الظاهر أدناه ثم أعد المحاولة.",
      );
    } finally {
      if (!redirecting) setSubmitting(false);
    }
  }

  const blocked = submitting || (!kept && (checking || !availability || availability.kind === "none"));

  return (
    <form onSubmit={onSubmit} noValidate className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {booked && (
        <p role="status" className="rounded-lg border border-green-600 bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950 dark:text-green-200">
          تم الحجز لكلية {booked.collegeName}. المرجع: {booked.reference}
          {booked.examWarning && " (تنبيه: يوم الحجز يصادف تاريخ الامتحان أو يأتي بعده)"}
        </p>
      )}
      {onBehalf && (
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-1 text-lg font-bold">الكلية</legend>
          <Field label="احجز نيابةً عن" error={attempted ? collegeError : undefined}>
            <select
              value={collegeId}
              onChange={(e) => setCollegeId(e.target.value)}
              aria-invalid={attempted && collegeError !== undefined}
              className={control}
            >
              <option value="">اختر الكلية</option>
              {onBehalf.colleges.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </fieldset>
      )}
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-lg font-bold">بيانات الدكتور والمستلم</legend>
        <Field label="اسم الدكتور" error={shown("doctorName")}>
          <input
            value={f.doctorName}
            onChange={(e) => set("doctorName", e.target.value)}
            onBlur={() => touch("doctorName")}
            maxLength={200}
            autoComplete="off"
            aria-invalid={shown("doctorName") !== undefined}
            className={control}
          />
        </Field>
        <Field
          label="رقم هاتف الدكتور"
          error={shown("doctorPhone")}
          hint={phone !== null ? `سيُحفظ بالصيغة: ${phone}` : undefined}
        >
          <input
            value={f.doctorPhone}
            onChange={(e) => set("doctorPhone", e.target.value)}
            onBlur={() => touch("doctorPhone")}
            type="tel"
            inputMode="tel"
            dir="ltr"
            maxLength={40}
            autoComplete="off"
            aria-invalid={shown("doctorPhone") !== undefined}
            className={`${control} text-left`}
          />
        </Field>
        <Field label="اسم المستلم رباعيًا" error={shown("recipientName")}>
          <input
            value={f.recipientName}
            onChange={(e) => set("recipientName", e.target.value)}
            onBlur={() => touch("recipientName")}
            maxLength={200}
            autoComplete="off"
            aria-invalid={shown("recipientName") !== undefined}
            className={control}
          />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-lg font-bold">بيانات العمل</legend>
        <Field label="المادة" error={shown("subject")}>
          <input
            value={f.subject}
            onChange={(e) => set("subject", e.target.value)}
            onBlur={() => touch("subject")}
            maxLength={200}
            autoComplete="off"
            aria-invalid={shown("subject") !== undefined}
            className={control}
          />
        </Field>
        <Field label="نوع الخدمة">
          <select
            value={f.serviceType}
            onChange={(e) => set("serviceType", e.target.value as ServiceType)}
            className={control}
          >
            {Object.entries(SERVICE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="عدد النسخ" error={shown("copies")}>
            <input
              value={f.copies}
              onChange={(e) => set("copies", e.target.value)}
              onBlur={() => touch("copies")}
              inputMode="numeric"
              dir="ltr"
              maxLength={9}
              autoComplete="off"
              aria-invalid={shown("copies") !== undefined}
              className={`${control} text-left`}
            />
          </Field>
          <Field label="عدد النماذج" error={shown("models")}>
            <input
              value={f.models}
              onChange={(e) => set("models", e.target.value)}
              onBlur={() => touch("models")}
              inputMode="numeric"
              dir="ltr"
              maxLength={9}
              autoComplete="off"
              aria-invalid={shown("models") !== undefined}
              className={`${control} text-left`}
            />
          </Field>
          <Field label="عدد الصفحات لكل نموذج" error={shown("pagesPerModel")}>
            <input
              value={f.pagesPerModel}
              onChange={(e) => set("pagesPerModel", e.target.value)}
              onBlur={() => touch("pagesPerModel")}
              inputMode="numeric"
              dir="ltr"
              maxLength={9}
              autoComplete="off"
              aria-invalid={shown("pagesPerModel") !== undefined}
              className={`${control} text-left`}
            />
          </Field>
        </div>
        <Field label="الطباعة">
          <select value={f.sides} onChange={(e) => set("sides", e.target.value as Sides)} className={control}>
            {Object.entries(SIDES_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="تاريخ الامتحان (اختياري)" error={shown("examDate")}>
          <input
            value={f.examDate}
            onChange={(e) => set("examDate", e.target.value)}
            onBlur={() => touch("examDate")}
            type="date"
            dir="ltr"
            aria-invalid={shown("examDate") !== undefined}
            className={`${control} text-left`}
          />
        </Field>
        {examWarning && (
          <p role="status" className="rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            تنبيه: يوم الحجز يصادف تاريخ الامتحان أو يأتي بعده. يمكنك المتابعة.
          </p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-lg font-bold">الموعد</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="اليوم"
            error={shown("date")}
            hint={`أيام العمل: ${config.workingWeekdays.map(weekdayName).join("، ")}`}
          >
            <input
              value={f.date}
              onChange={(e) => set("date", e.target.value)}
              onBlur={() => touch("date")}
              type="date"
              dir="ltr"
              min={config.today}
              aria-invalid={shown("date") !== undefined}
              className={`${control} text-left`}
            />
          </Field>
          <Field label="ساعة البدء" error={shown("hour")}>
            <select
              value={f.hour}
              onChange={(e) => set("hour", e.target.value)}
              onBlur={() => touch("hour")}
              aria-invalid={shown("hour") !== undefined}
              className={control}
            >
              <option value="">اختر الساعة</option>
              {hours.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {kept && edit ? (
          <div role="status" aria-live="polite" className={tone.info}>
            يبقى الحجز في موعده الحالي: {slotText(edit.slot.startsAt, edit.slot.endsAt)}
          </div>
        ) : (
          <AvailabilityBox query={query !== null} checking={checking} availability={availability} />
        )}
      </fieldset>

      {notice && (
        <p role="alert" className="rounded-lg border border-red-600 bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">
          {notice}
        </p>
      )}

      <button
        type="submit"
        disabled={blocked}
        className="rounded-lg bg-zinc-900 px-5 py-3 text-base font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {edit
          ? submitting
            ? "جارٍ الحفظ…"
            : availability?.kind === "suggestion"
              ? "احفظ بالموعد المقترح"
              : "احفظ التعديل"
          : submitting
            ? "جارٍ الحجز…"
            : availability?.kind === "suggestion"
              ? "احجز الموعد المقترح"
              : "احجز"}
      </button>
    </form>
  );
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </span>
      ) : hint ? (
        <span className="text-sm text-zinc-600 dark:text-zinc-400">{hint}</span>
      ) : null}
    </label>
  );
}

const box = "rounded-lg border p-3 text-sm";
const tone = {
  info: `${box} border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300`,
  good: `${box} border-green-600 bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-200`,
  warn: `${box} border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200`,
  bad: `${box} border-red-600 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200`,
};

function AvailabilityBox({
  query,
  checking,
  availability,
}: {
  query: boolean;
  checking: boolean;
  availability: Availability | null;
}) {
  let content: React.ReactNode;
  let kind: keyof typeof tone = "info";
  if (!query) {
    content = "أكمل بيانات العمل واختر اليوم والساعة لمعرفة التوفر.";
  } else if (checking) {
    content = "جارٍ التحقق من التوفر…";
  } else if (!availability) {
    kind = "bad";
    content = "تعذّر التحقق من التوفر. راجع البيانات.";
  } else if (availability.kind === "exact") {
    kind = "good";
    content = <>الموعد متاح: {slotText(availability.placement.startsAt, availability.placement.endsAt)}</>;
  } else if (availability.kind === "suggestion") {
    kind = "warn";
    content = (
      <>
        الموعد المطلوب غير متاح: {REFUSAL_LABEL[availability.reason]}.
        <br />
        أقرب موعد متاح: {slotText(availability.placement.startsAt, availability.placement.endsAt)}
      </>
    );
  } else {
    kind = "bad";
    content = (
      <>
        {REFUSAL_LABEL[availability.reason]}.
        {availability.reason === "too_long" && availability.maxCopies !== undefined && (
          <>
            <br />
            أكبر عدد نسخ يمكن إنجازه في يوم واحد: {availability.maxCopies}. يمكنك حجز العمل على عدة حجوزات منفصلة.
          </>
        )}
      </>
    );
  }
  return (
    <div role="status" aria-live="polite" className={tone[kind]}>
      {content}
    </div>
  );
}

function slotText(startsAt: Date, endsAt: Date): string {
  return `${formatDay(dayOf(startsAt))}، من ${timeOf(startsAt)} إلى ${timeOf(endsAt)}`;
}
