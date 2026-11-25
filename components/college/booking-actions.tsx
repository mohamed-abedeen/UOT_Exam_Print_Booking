"use client";
// The buttons on a college's booking card (step 2.5): edit (opens the form), cancel, and the one delay notice. The
// flags come from `listBookings`; they only decide which buttons show: each action checks the rules again.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { button, errorText, field } from "@/components/admin/styles";
import { cancelBooking, sendDelayNotice } from "@/lib/actions/bookings";
import { timeOf } from "@/lib/bookings/format";

type Panel = "cancel" | "delay" | null;

const CANCEL_REFUSED = "لم يعد الإلغاء ممكنًا: انتهت المهلة أو تغيّرت حالة الحجز.";
const DELAY_REFUSED = "لم يعد إشعار التأخير ممكنًا: انتهت المهلة، أو أُرسل من قبل، أو تغيّرت حالة الحجز.";

export function BookingActions({
  bookingId,
  canEdit,
  canDelay,
}: {
  bookingId: number;
  canEdit: boolean;
  canDelay: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function cancel() {
    startTransition(async () => {
      const result = await cancelBooking({ bookingId, reason });
      if (result.ok) {
        setPanel(null);
        return router.refresh();
      }
      setError(result.error === "validation" ? "تحقق من سبب الإلغاء." : CANCEL_REFUSED);
      router.refresh(); // the buttons may no longer be allowed
    });
  }

  function delay() {
    startTransition(async () => {
      const result = await sendDelayNotice({ bookingId });
      if (result.ok) {
        setPanel(null);
        setDone(
          result.moved
            ? `تم تأخير الموعد إلى ${timeOf(result.booking.startsAt)} – ${timeOf(result.booking.endsAt)}.`
            : "لا يوجد وقت متأخر متاح في هذا اليوم. يبقى الحجز في موعده وأُبلغت الإدارة لتقرر.",
        );
        return router.refresh();
      }
      setError(result.error === "slot_taken" ? "تغيّر التوفر قبل لحظات. حاول مرة أخرى." : DELAY_REFUSED);
      router.refresh();
    });
  }

  function open(next: Panel) {
    setPanel(next);
    setError(null);
    setDone(null);
    setReason("");
  }

  if (!canEdit && !canDelay && !done && !error) return null;

  return (
    <div className="flex flex-col gap-2">
      {panel === null && (canEdit || canDelay) && (
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Link href={`/college/edit/${bookingId}`} className={button}>
              تعديل
            </Link>
          )}
          {canEdit && (
            <button type="button" onClick={() => open("cancel")} className={button}>
              إلغاء الحجز
            </button>
          )}
          {canDelay && (
            <button type="button" onClick={() => open("delay")} className={button}>
              إشعار تأخير
            </button>
          )}
        </div>
      )}

      {panel === "cancel" && (
        <div className="flex flex-col gap-2 rounded-lg border border-red-600 p-3 text-sm">
          <p>سيُلغى الحجز ويُفرَّغ وقته، ولا يمكن التراجع عن ذلك.</p>
          <label className="flex flex-col gap-1">
            <span>سبب الإلغاء (اختياري)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={field} />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={cancel}
              className="rounded-lg bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-60"
            >
              {pending ? "جارٍ الإلغاء…" : "تأكيد الإلغاء"}
            </button>
            <button type="button" disabled={pending} onClick={() => open(null)} className={button}>
              تراجع
            </button>
          </div>
        </div>
      )}

      {panel === "delay" && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500 p-3 text-sm">
          <p>
            يُنقل الحجز إلى أحدث وقت متاح في اليوم نفسه بعد موعده الحالي. يُسمح بإشعار تأخير واحد لكل حجز، ولا يمكن
            التراجع عنه. إن لم يوجد وقت متأخر يبقى الحجز في موعده وتقرر الإدارة.
          </p>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={delay} className={button}>
              {pending ? "جارٍ الإرسال…" : "أرسل إشعار التأخير"}
            </button>
            <button type="button" disabled={pending} onClick={() => open(null)} className={button}>
              تراجع
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className={errorText}>
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="text-sm text-green-800 dark:text-green-300">
          {done}
        </p>
      )}
    </div>
  );
}
