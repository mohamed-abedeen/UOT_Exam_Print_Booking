// Step 4.1 — the daily printed sheet: one A4 landscape table, a row per booking with its two signature boxes
// (original handed in / copies received). The same component serves the operator and the admin; the page passes
// the rows it read through `getDailySheet`. The date picker, the print button and the nav are screen-only.
import { button, field } from "@/components/admin/styles";
import { PrintButton } from "@/components/print/print-button";
import {
  SERVICE_LABEL,
  SIDES_LABEL,
  STATUS_LABEL,
  formatDay,
  timeOf,
} from "@/lib/bookings/format";
import type { DayQueueRow } from "@/lib/bookings/queue";

const HEAD = [
  "الوقت",
  "المرجع",
  "الكلية",
  "الدكتور",
  "المستلم",
  "الموضوع",
  "الخدمة",
  "الكمية",
  "الوجهان",
  "الآلة",
  "تسليم الأصل",
  "استلام النسخ",
];
const cell = "border border-zinc-500 px-2 py-1";

export function DailySheet({
  action,
  date,
  rows,
  badDate,
}: {
  /** The page's own path: the date form is a plain GET back to it. */
  action: string;
  date: string;
  rows: DayQueueRow[];
  badDate: boolean;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <h1 className="text-lg font-bold">ورقة اليوم المطبوعة</h1>
        <form method="get" action={action} className="flex items-center gap-2">
          <input
            type="date"
            name="date"
            defaultValue={date}
            required
            className={field}
            dir="ltr"
          />
          <button type="submit" className={button}>
            عرض
          </button>
        </form>
        <PrintButton />
      </div>
      {badDate && (
        <p className="text-sm text-red-700 dark:text-red-400 print:hidden">
          التاريخ غير صالح، عُرض اليوم.
        </p>
      )}

      <h2 className="hidden text-lg font-bold print:block">
        جامعة طرابلس، مركز الطباعة، ورقة يوم <span dir="ltr">{date}</span> (
        {formatDay(date)})
      </h2>

      {rows.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          لا توجد حجوزات في هذا اليوم.
        </p>
      ) : (
        <div className="overflow-x-auto print:overflow-visible">
          <table className="w-full min-w-[64rem] border-collapse text-sm print:min-w-0 print:text-xs">
            <thead className="table-header-group">
              <tr>
                {HEAD.map((h) => (
                  <th key={h} className={`${cell} text-start font-bold`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="break-inside-avoid align-top">
                  <td className={`${cell} whitespace-nowrap`} dir="ltr">
                    {timeOf(r.startsAt)}–{timeOf(r.endsAt)}
                  </td>
                  <td className={`${cell} whitespace-nowrap`} dir="ltr">
                    {r.reference}
                  </td>
                  <td className={cell}>{r.collegeName}</td>
                  <td className={cell}>{r.doctorName}</td>
                  <td className={cell}>{r.recipientName}</td>
                  <td className={cell}>{r.subject}</td>
                  <td className={cell}>{SERVICE_LABEL[r.serviceType]}</td>
                  <td className={`${cell} whitespace-nowrap`}>
                    {r.copies} × {r.models} × {r.pagesPerModel}
                  </td>
                  <td className={`${cell} whitespace-nowrap`}>
                    {SIDES_LABEL[r.sides]}
                  </td>
                  <td className={`${cell} whitespace-nowrap`}>
                    {r.machineName}
                    {r.status === "no_show" && (
                      <div className="font-bold">{STATUS_LABEL[r.status]}</div>
                    )}
                  </td>
                  <td className="h-14 w-32 border border-zinc-500" />
                  <td className="h-14 w-32 border border-zinc-500" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
