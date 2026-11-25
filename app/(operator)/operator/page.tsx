// Step 1.7 — the operator's day queue: today's bookings by start time, one list with the machine as a column.
// Read-only; the buttons (confirm identity, ready, ...) come with step 2.2.
import { connection } from "next/server";
import { getDayQueue } from "@/lib/actions/bookings";
import type { DayQueueRow } from "@/lib/bookings/queue";
import { localDate } from "@/lib/scheduling/time";

const STATUS_LABEL: Record<DayQueueRow["status"], string> = {
  booked: "محجوز",
  in_progress: "قيد التنفيذ",
  ready: "جاهز للاستلام",
  delivered: "تم التسليم",
  cancelled: "ملغى",
  no_show: "لم يحضر",
};
const SERVICE_LABEL: Record<DayQueueRow["serviceType"], string> = {
  exam_questions: "أسئلة امتحان",
  results: "نتائج",
  quality: "جودة",
  answer_sheets: "أوراق إجابة",
};
const SIDES_LABEL: Record<DayQueueRow["sides"], string> = { single: "وجه واحد", duplex: "وجهان" };

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Tripoli" });
const timeOf = (at: Date) => clock.format(at);

export default async function OperatorPage() {
  await connection(); // "today" is read per request, never at build time
  const today = localDate(new Date());
  const result = await getDayQueue(today); // the action's first line is the role guard

  if (!result.ok) return <p>تعذّر تحميل قائمة اليوم.</p>;
  const { rows } = result;

  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-lg font-bold">
        قائمة اليوم <span dir="ltr">{today}</span>
      </h1>
      {rows.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">لا توجد حجوزات اليوم.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-zinc-300 text-start dark:border-zinc-700">
                {["الوقت", "الآلة", "المرجع", "الكلية", "الدكتور", "المستلم", "الموضوع", "الخدمة", "الكمية", "الحالة"].map((h) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
