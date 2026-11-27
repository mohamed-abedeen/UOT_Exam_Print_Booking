// Step 1.7 — the operator's day queue: today's bookings by start time, one list with the machine as a column.
// The buttons of each row (confirm identity, ready, delivered, no-show, WhatsApp) are components/operator/row-actions.tsx (step 2.2).
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { RowActions } from "@/components/operator/row-actions";
import { getDayQueue } from "@/lib/actions/bookings";
import { SERVICE_LABEL, SIDES_LABEL, STATUS_LABEL, timeOf } from "@/lib/bookings/format";
import { localDate } from "@/lib/scheduling/time";

// The queue reads the session, the clock and the database, so it streams in behind its own <Suspense>
// (same as the college and admin pages; Next 16 instant-navigation check).
export default function OperatorPage() {
  return (
    <Suspense fallback={<p className="text-zinc-600 dark:text-zinc-400">جارٍ التحميل…</p>}>
      <DayQueue />
    </Suspense>
  );
}

async function DayQueue() {
  await connection(); // "today" is read per request, never at build time
  const today = localDate(new Date());
  const result = await getDayQueue(today); // the action's first line is the role guard

  if (!result.ok) return <p>تعذّر تحميل قائمة اليوم.</p>;
  const { rows } = result;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold">
          قائمة اليوم <span dir="ltr">{today}</span>
        </h1>
        <Link href="/operator/sheet" className="text-sm underline underline-offset-4">
          ورقة اليوم المطبوعة
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">لا توجد حجوزات اليوم.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[72rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-zinc-300 text-start dark:border-zinc-700">
                {["الوقت", "الآلة", "المرجع", "الكلية", "الدكتور", "المستلم", "الموضوع", "الخدمة", "الكمية", "الحالة", "الإجراءات"].map((h) => (
                  <th key={h} className="px-2 py-2 text-start font-bold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-zinc-200 align-top dark:border-zinc-800">
                  <td className="px-2 py-2 whitespace-nowrap" dir="ltr">
                    {timeOf(r.startsAt)}–{timeOf(r.endsAt)}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">{r.machineName}</td>
                  <td className="px-2 py-2 whitespace-nowrap" dir="ltr">
                    {r.reference}
                  </td>
                  <td className="px-2 py-2">{r.collegeName}</td>
                  <td className="px-2 py-2">{r.doctorName}</td>
                  <td className="px-2 py-2">{r.recipientName}</td>
                  <td className="px-2 py-2">{r.subject}</td>
                  <td className="px-2 py-2">{SERVICE_LABEL[r.serviceType]}</td>
                  <td className="px-2 py-2">
                    {r.copies} × {r.models} × {r.pagesPerModel}، {SIDES_LABEL[r.sides]}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    {STATUS_LABEL[r.status]}
                    {r.needsReschedule && <span className="ms-2 font-bold text-red-700 dark:text-red-400">يحتاج إعادة جدولة</span>}
                  </td>
                  <td className="px-2 py-2">
                    <RowActions
                      id={r.id}
                      reference={r.reference}
                      status={r.status}
                      needsReschedule={r.needsReschedule}
                      startsAt={r.startsAt}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
