"use client";
// Stop / reactivate machines and read the maintenance log (step 2.5; the rules are contracts §3.8). A stop is an
// inline panel, like the machine form: the admin gives when it starts, until when, and why.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { button, buttonPrimary, errorText, field, td, th } from "@/components/admin/styles";
import type { MachineRow } from "@/lib/actions/machines";
import { endMaintenance, startMaintenance } from "@/lib/actions/maintenance";
import { dayTime, durationText } from "@/lib/bookings/format";
import type { MaintenanceItem } from "@/lib/maintenance";
import { isOpenWindow, windowState, type WindowState } from "@/lib/maintenance/windows";
import { atMinutes, minutesOfDay } from "@/lib/scheduling/time";

const START_ERROR: Record<string, string> = {
  validation: "تحقق من التواريخ والسبب: البدء المجدول يكون في المستقبل، والنهاية بعد البدء.",
  not_found: "الآلة غير موجودة أو مؤرشفة.",
  overlaps: "تتداخل هذه الفترة مع صيانة أخرى مسجلة لنفس الآلة.",
};
const END_ERROR: Record<string, string> = {
  validation: "تعذّر إنهاء الصيانة.",
  not_found: "الصيانة غير موجودة.",
  refused: "هذه الصيانة انتهت أو أُلغيت من قبل.",
};
const STATE_LABEL: Record<WindowState, string> = {
  active: "جارية",
  planned: "مجدولة",
  over: "انتهت",
  ended: "أُعيد التشغيل",
  cancelled: "أُلغيت قبل أن تبدأ",
};

type Touched = { id: number; reference: string };
type Notice = { text: string; link: boolean };

const refs = (list: Touched[]) => list.map((b) => b.reference).join("، ");

/** 'YYYY-MM-DD' + 'HH:MM' on the business clock → an instant, or null while one of them is empty. */
function instantOf(date: string, time: string): Date | null {
  return date === "" || time === "" ? null : atMinutes(date, minutesOfDay(time));
}

function StopForm({
  machine,
  now,
  onDone,
  onCancel,
}: {
  machine: MachineRow;
  now: Date;
  onDone: (notice: Notice) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [later, setLater] = useState(false);
  const [timed, setTimed] = useState(false);

  function submit(formData: FormData) {
    const text = (key: string) => String(formData.get(key) ?? "");
    const startsAt = later ? instantOf(text("startDate"), text("startTime")) : null;
    const endsAt = timed ? instantOf(text("endDate"), text("endTime")) : null;
    if ((later && !startsAt) || (timed && !endsAt)) return setError("أدخل اليوم والوقت.");
    if (startsAt && startsAt.getTime() <= now.getTime()) return setError("البدء المجدول يجب أن يكون في المستقبل.");
    if (endsAt && endsAt.getTime() <= (startsAt ?? now).getTime()) return setError("وقت النهاية يجب أن يكون بعد البدء.");

    startTransition(async () => {
      const result = await startMaintenance({
        machineId: machine.id,
        ...(startsAt ? { startsAt } : {}),
        endsAt,
        reason: text("reason"),
      });
      if (!result.ok) return setError(START_ERROR[result.error]);
      setError(null);
      const parts = ["سُجّل الإيقاف."];
      if (result.moved.length > 0) {
        parts.push(`نُقل ${result.moved.length} حجزًا إلى آلة أخرى في الوقت نفسه (${refs(result.moved)}).`);
      }
      if (result.flagged.length > 0) {
        parts.push(`${result.flagged.length} حجزًا لم يجد آلة بديلة وينتظر إعادة الجدولة (${refs(result.flagged)}).`);
      }
      if (result.moved.length === 0 && result.flagged.length === 0) parts.push("لا توجد حجوزات متأثرة.");
      router.refresh();
      onDone({ text: parts.join(" "), link: result.flagged.length > 0 });
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(new FormData(e.currentTarget));
      }}
      className="mb-6 flex max-w-2xl flex-col gap-4 rounded-2xl border border-border p-4 bg-card">
      <h2 className="font-bold">إيقاف الآلة: {machine.name}</h2>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">متى يبدأ الإيقاف؟</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="when" checked={!later} onChange={() => setLater(false)} />
          <span>الآن</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="when" checked={later} onChange={() => setLater(true)} />
          <span>في موعد لاحق (صيانة مجدولة)</span>
        </label>
        {later && (
          <div className="flex flex-wrap gap-2">
            <input name="startDate" type="date" required dir="ltr" aria-label="يوم البدء" className={field} />
            <input name="startTime" type="time" required dir="ltr" aria-label="وقت البدء" className={field} />
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">حتى متى؟</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="until" checked={!timed} onChange={() => setTimed(false)} />
          <span>حتى إعادة التشغيل يدويًا</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="until" checked={timed} onChange={() => setTimed(true)} />
          <span>حتى وقت محدد</span>
        </label>
        {timed && (
          <div className="flex flex-wrap gap-2">
            <input name="endDate" type="date" required dir="ltr" aria-label="يوم النهاية" className={field} />
            <input name="endTime" type="time" required dir="ltr" aria-label="وقت النهاية" className={field} />
          </div>
        )}
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">السبب</span>
        <input name="reason" required maxLength={500} className={field} />
      </label>

      <p className="text-sm text-muted-foreground">
        الحجوزات التي تقع في فترة الإيقاف تُنقل تلقائيًا إلى آلة مناسبة في الوقت نفسه إن وُجدت، وإلا تُوضع في قائمة إعادة
        الجدولة.
      </p>

      {error && (
        <p role="alert" className={errorText}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "جارٍ التسجيل…" : "سجّل الإيقاف"}
        </button>
        <button type="button" disabled={pending} onClick={onCancel} className={button}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

function windowText(w: MaintenanceItem, state: WindowState): string {
  const to = w.endsAt === null ? "حتى إعادة التشغيل" : `حتى ${dayTime(w.endsAt)}`;
  return state === "active" ? `متوقفة منذ ${dayTime(w.startsAt)} ${to}` : `صيانة مجدولة من ${dayTime(w.startsAt)} ${to}`;
}

export function MaintenanceManager({
  machines,
  items,
  now,
}: {
  machines: MachineRow[];
  items: MaintenanceItem[];
  now: Date;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [stopping, setStopping] = useState<MachineRow | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const states = new Map(items.map((w) => [w.id, windowState(w, now)]));

  function end(w: MaintenanceItem) {
    startTransition(async () => {
      const result = await endMaintenance({ maintenanceId: w.id });
      router.refresh();
      if (!result.ok) {
        setNotice(null);
        return setError(END_ERROR[result.error]);
      }
      setError(null);
      setNotice({
        text:
          result.restored.length > 0
            ? `تم. استُعيد ${result.restored.length} حجزًا إلى آلته (${refs(result.restored)}) وأُبلغت الكليات.`
            : "تم.",
        link: false,
      });
    });
  }

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h1 className="mb-4 text-xl font-bold md:text-2xl">الصيانة</h1>
        {stopping && (
          <StopForm
            key={stopping.id}
            machine={stopping}
            now={now}
            onCancel={() => setStopping(null)}
            onDone={(n) => {
              setStopping(null);
              setError(null);
              setNotice(n);
            }}
          />
        )}
        {notice && (
          <p role="status" className="mb-3 notice notice--ok">
            {notice.text}{" "}
            {notice.link && (
              <Link href="/admin/reschedule" className="font-medium underline">
                فتح قائمة إعادة الجدولة
              </Link>
            )}
          </p>
        )}
        {error && (
          <p role="alert" className={`${errorText} mb-3`}>
            {error}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>الآلة</th>
                <th className={th}>الحالة</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => {
                const open = items.filter((w) => w.machineId === m.id && isOpenWindow(states.get(w.id)!));
                return (
                  <tr key={m.id}>
                    <td className={td}>{m.name}</td>
                    <td className={td}>
                      {open.length === 0 ? (
                        "تعمل"
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {open.map((w) => (
                            <li key={w.id} className="flex flex-wrap items-center gap-2">
                              <span>
                                {windowText(w, states.get(w.id)!)} · {w.reason}
                              </span>
                              <button type="button" disabled={pending} onClick={() => end(w)} className={button}>
                                {states.get(w.id) === "active" ? "إعادة التشغيل" : "إلغاء الصيانة المجدولة"}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          setNotice(null);
                          setError(null);
                          setStopping(m);
                        }}
                        className={button}>
                        إيقاف / صيانة
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-[15px] font-bold">سجل الصيانة</h2>
        {items.length === 0 ? (
          <p className="rounded-2xl border border-dashed bg-card px-6 py-14 text-center text-muted-foreground">لا توجد سجلات صيانة بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={th}>الآلة</th>
                  <th className={th}>من</th>
                  <th className={th}>إلى</th>
                  <th className={th}>المدة</th>
                  <th className={th}>الحالة</th>
                  <th className={th}>السبب</th>
                  <th className={th}>سجّلها</th>
                  <th className={th}>أنهاها</th>
                </tr>
              </thead>
              <tbody>
                {items.map((w) => (
                  <tr key={w.id}>
                    <td className={td}>{w.machineName}</td>
                    <td className={td}>{dayTime(w.startsAt)}</td>
                    <td className={td}>{w.endsAt ? dayTime(w.endsAt) : "مفتوحة"}</td>
                    <td className={td}>{w.minutes === null ? "—" : durationText(w.minutes)}</td>
                    <td className={td}>{STATE_LABEL[states.get(w.id)!]}</td>
                    <td className={td}>{w.reason}</td>
                    <td className={td}>{w.createdByName}</td>
                    <td className={td}>{w.endedByName && w.endedAt ? `${w.endedByName} · ${dayTime(w.endedAt)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
