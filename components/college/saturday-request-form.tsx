"use client";
// The college's Saturday request (step 2.7, contracts §4 "Saturday"): a Saturday date, the quantity the college
// expects to print that day in impressions (copies × models × pages), and a reason. The date is checked here for a
// quick answer (`saturdayDateIssue`); a holiday and a second open request for the same date are known to the server.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createSaturdayRequest } from "@/lib/actions/saturday";
import { digits } from "@/lib/bookings/format";
import { saturdayDateIssue, type SaturdayDateIssue } from "@/lib/saturday/dates";

const control =
  "glass-field w-full text-base";

const DATE_ISSUE: Record<SaturdayDateIssue, string> = {
  not_saturday: "اختر يوم سبت.",
  not_future: "اختر سبتًا قادمًا (بعد اليوم).",
  working_day: "السبت يوم عمل عادي، ولا حاجة إلى طلب.",
};
const SERVER_ERROR = {
  duplicate: "لديك طلب قيد المراجعة أو موافق عليه لهذا اليوم.",
  validation: "تعذّر إرسال الطلب: قد يكون اليوم عطلة رسمية أو لم يعد سبتًا قادمًا. راجع البيانات.",
} as const;

/** The text as a whole number, or NaN. Arabic-Indic digits are accepted. */
function whole(text: string): number {
  const s = digits(text).trim();
  return /^\d{1,9}$/.test(s) ? Number(s) : Number.NaN;
}

export function SaturdayRequestForm({ today, workingWeekdays }: { today: string; workingWeekdays: number[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [date, setDate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const errors: { date?: string; quantity?: string; reason?: string } = {};
  const issue = date === "" ? null : saturdayDateIssue(date, today, workingWeekdays);
  if (date === "") errors.date = "اختر يوم السبت";
  else if (issue) errors.date = DATE_ISSUE[issue];
  const amount = whole(quantity);
  if (!(Number.isInteger(amount) && amount >= 1)) errors.quantity = "أدخل عددًا صحيحًا موجبًا";
  if (reason.trim() === "") errors.reason = "اذكر سبب الطلب";
  const shown = <K extends keyof typeof errors>(key: K) => (attempted ? errors[key] : undefined);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    setError(null);
    setSent(null);
    if (Object.keys(errors).length > 0) return;
    startTransition(async () => {
      const result = await createSaturdayRequest({ date, expectedQuantity: amount, reason });
      if (!result.ok) return setError(SERVER_ERROR[result.error]);
      setSent(date);
      setDate("");
      setQuantity("");
      setReason("");
      setAttempted(false);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 rounded-2xl border border-border p-4 bg-card">
      <h2 className="text-[15px] font-bold">طلب يوم سبت</h2>
      <p className="text-sm text-muted-foreground">
        يُفتح اليوم لكليتك فقط وحتى الكمية التي يعتمدها المسؤول.
      </p>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">يوم السبت</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          min={today}
          dir="ltr"
          aria-invalid={shown("date") !== undefined}
          className={`${control} text-left`}
        />
        <FieldError text={shown("date")} />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">الكمية المتوقعة (عدد الأوجه المطبوعة)</span>
        <input
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          inputMode="numeric"
          dir="ltr"
          maxLength={9}
          autoComplete="off"
          aria-invalid={shown("quantity") !== undefined}
          className={`${control} text-left`}
        />
        <span className="text-sm text-muted-foreground">عدد النسخ × عدد النماذج × عدد الصفحات لكل نموذج، لكل أعمال ذلك اليوم.</span>
        <FieldError text={shown("quantity")} />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">سبب الطلب</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          aria-invalid={shown("reason") !== undefined}
          className={control}
        />
        <FieldError text={shown("reason")} />
      </label>

      {error && (
        <p role="alert" className="notice notice--bad">
          {error}
        </p>
      )}
      {sent && (
        <p role="status" className="notice notice--ok">
          أُرسل طلب يوم <bdi>{sent}</bdi>. سيصلك القرار هنا في القائمة أدناه.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="glass-blue inline-flex h-11 items-center justify-center gap-2 px-5 font-semibold text-base disabled:opacity-50"
      >
        {pending ? "جارٍ الإرسال…" : "أرسل الطلب"}
      </button>
    </form>
  );
}

function FieldError({ text }: { text?: string }) {
  return text ? (
    <span role="alert" className="text-sm text-danger">
      {text}
    </span>
  ) : null;
}
