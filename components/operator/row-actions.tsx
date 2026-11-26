"use client";
// The buttons of one row of the operator's day queue (step 2.2): confirm identity (T2), "ready" with the waste form
// (T3), delivered (T4), no-show (T7) and the two WhatsApp links. The server decides (each action is one guarded
// UPDATE); the buttons only show what the status allows. A refusal means the row moved: the page is read again.
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { button, buttonPrimary, errorText, field } from "@/components/admin/styles";
import { confirmIdentity, getWhatsAppLink, markDelivered, markNoShow, markReady } from "@/lib/actions/bookings";
import { digits } from "@/lib/bookings/format";
import type { BookingStatus } from "@/lib/scheduling/types";

const ERROR: Record<string, string> = {
  validation: "القيم المدخلة غير صالحة.",
  not_found: "الحجز غير موجود.",
  refused: "تعذّر تنفيذ الإجراء: تغيّرت حالة الحجز أو لم تتحقق شروطه. حُدّثت القائمة.",
};

type Outcome = { ok: boolean; error?: string };

/** A whole number of sheets from the text (Arabic-Indic digits accepted), or NaN. */
function sheetsOf(text: string): number {
  const s = digits(text).trim();
  return /^\d{1,9}$/.test(s) ? Number(s) : Number.NaN;
}

export function RowActions({
  id,
  reference,
  status,
  needsReschedule,
  startsAt,
}: {
  id: number;
  reference: string;
  status: BookingStatus;
  needsReschedule: boolean;
  startsAt: Date;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [readyOpen, setReadyOpen] = useState(false);
  const [sheets, setSheets] = useState("");
  const [destroyed, setDestroyed] = useState(false);
  const [link, setLink] = useState<string | null>(null); // the wa.me link when the browser blocked the new tab
  // The no-show button opens at the start time. `null` until the page is in the browser (the server's clock is not shown).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (status !== "booked") return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [status]);

  function run(action: () => Promise<Outcome>, onOk?: () => void) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(ERROR[result.error ?? "validation"] ?? ERROR.validation);
        if (result.error === "refused" || result.error === "not_found") router.refresh();
        return;
      }
      setError(null);
      onOk?.();
      router.refresh();
    });
  }

  function whatsApp(kind: "started" | "ready") {
    // The tab is opened inside the click (a popup opened after the wait would be blocked), then pointed at the link.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    setLink(null);
    startTransition(async () => {
      const result = await getWhatsAppLink({ bookingId: id, kind });
      if (!result.ok) {
        tab?.close();
        setError(ERROR[result.error] ?? ERROR.validation);
        return;
      }
      setError(null);
      if (tab) tab.location.href = result.url;
      else setLink(result.url);
    });
  }

  function submitReady(e: React.FormEvent) {
    e.preventDefault();
    run(
      () => markReady({ bookingId: id, wastedSheets: sheetsOf(sheets), wasteDestroyed: true }),
      () => {
        setReadyOpen(false);
        setSheets("");
        setDestroyed(false);
      },
    );
  }

  if (status !== "booked" && status !== "in_progress" && status !== "ready") {
    return <span className="text-zinc-500">—</span>; // delivered, cancelled and no_show are final
  }

  const started = now !== null && now >= startsAt.getTime();
  const sheetsOk = !Number.isNaN(sheetsOf(sheets));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {status === "booked" && (
          <>
            <button
              type="button"
              className={button}
              disabled={pending || needsReschedule}
              title={needsReschedule ? "الحجز يحتاج إعادة جدولة" : undefined}
              onClick={() => run(() => confirmIdentity({ bookingId: id }))}
            >
              تأكيد الهوية
            </button>
            <button
              type="button"
              className={button}
              disabled={pending || !started}
              title={started ? undefined : "لا يمكن تسجيل عدم الحضور قبل موعد البدء"}
              onClick={() => {
                if (confirm(`تسجيل عدم حضور الحجز ${reference}؟ سيُحرَّر الوقت ولا يمكن التراجع.`)) {
                  run(() => markNoShow({ bookingId: id }));
                }
              }}
            >
              لم يحضر
            </button>
          </>
        )}
        {status === "in_progress" && (
          <>
            <button type="button" className={button} disabled={pending} onClick={() => whatsApp("started")}>
              واتساب: بدأ العمل
            </button>
            <button type="button" className={button} disabled={pending} onClick={() => setReadyOpen((o) => !o)}>
              جاهز
            </button>
          </>
        )}
        {status === "ready" && (
          <>
            <button type="button" className={button} disabled={pending} onClick={() => whatsApp("ready")}>
              واتساب: جاهز
            </button>
            <button
              type="button"
              className={button}
              disabled={pending}
              onClick={() => {
                if (confirm(`تأكيد تسليم الحجز ${reference}؟`)) run(() => markDelivered({ bookingId: id }));
              }}
            >
              تم التسليم
            </button>
          </>
        )}
      </div>

      {status === "in_progress" && readyOpen && (
        <form onSubmit={submitReady} className="flex flex-col gap-2 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
          <label className="flex items-center gap-2">
            <span>الأوراق التالفة</span>
            <input
              className={`${field} w-24`}
              inputMode="numeric"
              dir="ltr"
              value={sheets}
              onChange={(e) => setSheets(e.target.value)}
              placeholder="0"
              aria-invalid={sheets !== "" && !sheetsOk}
              required
            />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={destroyed} onChange={(e) => setDestroyed(e.target.checked)} />
            <span>تم إتلاف النسخ التالفة</span>
          </label>
          <div className="flex gap-2">
            <button type="submit" className={buttonPrimary} disabled={pending || !sheetsOk || !destroyed}>
              تأكيد الجاهزية
            </button>
            <button type="button" className={button} disabled={pending} onClick={() => setReadyOpen(false)}>
              إلغاء
            </button>
          </div>
        </form>
      )}

      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer" className="text-sm underline">
          فتح رابط واتساب
        </a>
      )}
      {error && (
        <p role="alert" className={errorText}>
          {error}
        </p>
      )}
    </div>
  );
}
