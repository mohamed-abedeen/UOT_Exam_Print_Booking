"use client";
// The bookings that wait for the admin (contracts §3.8 `listNeedsReschedule`): each one is resolved here by moving
// it to a machine, a day and a time on the 10-minute grid (`moveBooking`, §3.7). The server checks every rule and
// answers with the reason when the target is refused; nothing changes then.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { button, buttonPrimary, errorText, field, td, th } from "@/components/admin/styles";
import type { MachineRow } from "@/lib/actions/machines";
import { moveBooking } from "@/lib/actions/bookings";
import { dayOf, dayTime, MOVE_REFUSAL_LABEL, RESCHEDULE_REASON_LABEL, STATUS_LABEL, timeOf } from "@/lib/bookings/format";
import type { NeedsRescheduleItem } from "@/lib/bookings/read";
import { atMinutes, minutesOfDay, SLOT_MINUTES } from "@/lib/scheduling/time";

const MOVE_ERROR: Record<string, string> = {
  validation: "تحقق من اليوم والوقت (الوقت بمضاعفات 10 دقائق).",
  not_found: "الحجز غير موجود.",
  refused: "لم يعد الحجز قابلًا للنقل: تغيّرت حالته.",
};

function MoveForm({
  booking: b,
  machines,
  onDone,
  onCancel,
}: {
  booking: NeedsRescheduleItem;
  machines: MachineRow[];
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(formData: FormData) {
    const machineId = Number(formData.get("machineId"));
    const date = String(formData.get("date") ?? "");
    const time = String(formData.get("time") ?? "");
    if (!date || !time) return setError("أدخل اليوم والوقت.");
    const minutes = minutesOfDay(time);
    if (minutes % SLOT_MINUTES !== 0) return setError(`الوقت بمضاعفات ${SLOT_MINUTES} دقائق.`);
    const startsAt = atMinutes(date, minutes);

    startTransition(async () => {
      const result = await moveBooking({ bookingId: b.id, machineId, startsAt });
      if (!result.ok) {
        setError(result.error === "slot_taken" ? MOVE_REFUSAL_LABEL[result.reason] : MOVE_ERROR[result.error]);
        return;
      }
      setError(null);
      const machine = machines.find((m) => m.id === result.booking.machineId);
      router.refresh();
      onDone(
        `نُقل الحجز ${result.booking.reference} إلى ${machine?.name ?? "الآلة"}: ${dayTime(result.booking.startsAt)} – ${timeOf(result.booking.endsAt)}، وأُبلغت الكلية.`,
      );
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(new FormData(e.currentTarget));
      }}
      className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span>الآلة</span>
        <select name="machineId" defaultValue={b.machineId} className={field}>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>اليوم</span>
        <input name="date" type="date" required dir="ltr" defaultValue={dayOf(b.startsAt)} className={field} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>وقت البدء</span>
        <input
          name="time"
          type="time"
          step={SLOT_MINUTES * 60}
          required
          dir="ltr"
          defaultValue={timeOf(b.startsAt)}
          className={field}
        />
      </label>
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "جارٍ النقل…" : "انقل"}
      </button>
      <button type="button" disabled={pending} onClick={onCancel} className={button}>
        إلغاء
      </button>
      {error && (
        <p role="alert" className={`${errorText} basis-full`}>
          {error}
        </p>
      )}
    </form>
  );
}

export function RescheduleManager({
  bookings,
  machines,
}: {
  bookings: NeedsRescheduleItem[];
  machines: MachineRow[];
}) {
  const [moving, setMoving] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <section>
      <h1 className="mb-4 text-xl font-bold">إعادة الجدولة</h1>
      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
        حجوزات لم تجد آلة بديلة أو وقتًا متأخرًا. انقل كل حجز إلى آلة ووقت مناسبين، وتُبلَّغ الكلية بالموعد الجديد.
      </p>
      {notice && (
        <p role="status" className="mb-3 rounded-lg border border-green-600 bg-green-50 p-3 text-green-900 dark:bg-green-950 dark:text-green-200">
          {notice}
        </p>
      )}
      {bookings.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">لا توجد حجوزات تنتظر إعادة الجدولة.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>المرجع</th>
                <th className={th}>الكلية</th>
                <th className={th}>المادة</th>
                <th className={th}>الموعد الحالي</th>
                <th className={th}>الآلة</th>
                <th className={th}>الحالة</th>
                <th className={th}>السبب</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <RescheduleRow
                  key={b.id}
                  booking={b}
                  machines={machines}
                  open={moving === b.id}
                  onOpen={() => {
                    setNotice(null);
                    setMoving(b.id);
                  }}
                  onClose={() => setMoving(null)}
                  onDone={(text) => {
                    setMoving(null);
                    setNotice(text);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RescheduleRow({
  booking: b,
  machines,
  open,
  onOpen,
  onClose,
  onDone,
}: {
  booking: NeedsRescheduleItem;
  machines: MachineRow[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  return (
    <>
      <tr>
        <td className={td} dir="ltr">
          {b.reference}
        </td>
        <td className={td}>{b.collegeName}</td>
        <td className={td}>{b.subject}</td>
        <td className={td}>
          {dayTime(b.startsAt)} – {timeOf(b.endsAt)}
        </td>
        <td className={td}>{b.machineName}</td>
        <td className={td}>{STATUS_LABEL[b.status]}</td>
        <td className={td}>{RESCHEDULE_REASON_LABEL[b.rescheduleReason]}</td>
        <td className={`${td} whitespace-nowrap`}>
          {!open && (
            <button type="button" onClick={onOpen} className={button}>
              نقل
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td className={td} colSpan={8}>
            <MoveForm booking={b} machines={machines} onCancel={onClose} onDone={onDone} />
          </td>
        </tr>
      )}
    </>
  );
}
