"use client";
// Step 4.2 — the four report tables. Read-only: the range is a plain GET back to the page, so a reload or a shared
// link shows the same numbers; the tab is the only state kept here.
import { useState } from "react";
import { button, field, hint, noticeWarn, td, th } from "@/components/admin/styles";
import { durationText } from "@/lib/bookings/format";
import type { CollegeReportResult, MachineReportResult, PeakHoursResult, WasteAndStockResult } from "@/lib/reports";
import { percentText, REPORT_TABS, type ReportTab } from "@/lib/reports/form";
import { formatCount } from "@/lib/stock/form";

type Ok<T> = Extract<T, { ok: true }>;

export function ReportsView({
  from,
  to,
  badRange,
  colleges,
  machines,
  stock,
  peak,
}: {
  from: string;
  to: string;
  badRange: boolean;
  colleges: Ok<CollegeReportResult>;
  machines: Ok<MachineReportResult>;
  stock: Ok<WasteAndStockResult>;
  peak: Ok<PeakHoursResult>;
}) {
  const [tab, setTab] = useState<ReportTab>("colleges");
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold md:text-2xl">التقارير</h1>
        <form method="get" action="/admin/reports" className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">
            من
            <input type="date" name="from" defaultValue={from} required className={field} dir="ltr" />
          </label>
          <label className="flex items-center gap-1">
            إلى
            <input type="date" name="to" defaultValue={to} required className={field} dir="ltr" />
          </label>
          <button type="submit" className={button}>
            عرض
          </button>
        </form>
      </div>
      {badRange && <p className={noticeWarn}>المدى غير صالح، عُرض هذا الشهر حتى اليوم.</p>}
      <p className={hint}>
        الحجوزات تُحسب بتاريخ بدايتها، والحجز القائم هو كل حجز غير ملغى ولا غائب.
      </p>

      <div role="tablist" className="flex flex-wrap gap-2">
        {REPORT_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`${button} ${tab === t.key ? "bg-primary-soft font-bold text-primary" : ""}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "colleges" && <CollegesTable data={colleges} />}
      {tab === "machines" && <MachinesTable data={machines} />}
      {tab === "stock" && <StockTables data={stock} />}
      {tab === "peak" && <PeakTable data={peak} />}
    </section>
  );
}

const num = "tabular-nums";
const totalRow = "font-bold";

function Empty() {
  return <p className="rounded-2xl border border-dashed bg-card px-6 py-14 text-center text-muted-foreground">لا توجد بيانات في هذا المدى.</p>;
}

function CollegesTable({ data }: { data: Ok<CollegeReportResult> }) {
  if (data.rows.length === 0) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className={th}>الكلية</th>
            <th className={th}>الحجوزات</th>
            <th className={th}>الطبعات</th>
            <th className={th}>الأوراق</th>
            <th className={th}>الملغاة</th>
            <th className={th}>الغياب</th>
            <th className={th}>إشعارات التأخير</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.collegeId}>
              <td className={td}>{r.collegeName}</td>
              <td className={`${td} ${num}`}>{formatCount(r.bookings)}</td>
              <td className={`${td} ${num}`}>{formatCount(r.impressions)}</td>
              <td className={`${td} ${num}`}>{formatCount(r.sheets)}</td>
              <td className={`${td} ${num}`}>{formatCount(r.cancelled)}</td>
              <td className={`${td} ${num}`}>{formatCount(r.noShows)}</td>
              <td className={`${td} ${num}`}>{formatCount(r.delayNotices)}</td>
            </tr>
          ))}
          <tr className={totalRow}>
            <td className={td}>المجموع</td>
            <td className={`${td} ${num}`}>{formatCount(data.totals.bookings)}</td>
            <td className={`${td} ${num}`}>{formatCount(data.totals.impressions)}</td>
            <td className={`${td} ${num}`}>{formatCount(data.totals.sheets)}</td>
            <td className={`${td} ${num}`}>{formatCount(data.totals.cancelled)}</td>
            <td className={`${td} ${num}`}>{formatCount(data.totals.noShows)}</td>
            <td className={`${td} ${num}`}>{formatCount(data.totals.delayNotices)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MachinesTable({ data }: { data: Ok<MachineReportResult> }) {
  if (data.rows.length === 0) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className={th}>الآلة</th>
            <th className={th}>الحجوزات</th>
            <th className={th}>الطبعات</th>
            <th className={th}>الوقت المحجوز</th>
            <th className={th}>وقت التوقف</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.machineId}>
              <td className={td}>
                {r.machineName}
                {r.archived && <span className={hint}> (مؤرشفة)</span>}
              </td>
              <td className={`${td} ${num}`}>{formatCount(r.bookings)}</td>
              <td className={`${td} ${num}`}>{formatCount(r.impressions)}</td>
              <td className={`${td} ${num}`}>{durationText(r.bookedMinutes)}</td>
              <td className={`${td} ${num}`}>{durationText(r.downtimeMinutes)}</td>
            </tr>
          ))}
          <tr className={totalRow}>
            <td className={td}>المجموع</td>
            <td className={`${td} ${num}`}>{formatCount(data.totals.bookings)}</td>
            <td className={`${td} ${num}`}>{formatCount(data.totals.impressions)}</td>
            <td className={`${td} ${num}`}>{durationText(data.totals.bookedMinutes)}</td>
            <td className={`${td} ${num}`}>{durationText(data.totals.downtimeMinutes)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function StockTables({ data }: { data: Ok<WasteAndStockResult> }) {
  const { waste } = data;
  const rate = percentText(waste.wastedSheets, waste.sheets);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="mb-2 font-bold">الهدر في الحجوزات المنجزة</h2>
        <p className={hint}>حجوزات صارت جاهزة في هذا المدى، بتاريخ جاهزيتها.</p>
        <table className="mt-2 w-full max-w-xl text-sm">
          <tbody>
            <tr>
              <td className={td}>الحجوزات المنجزة</td>
              <td className={`${td} ${num}`}>{formatCount(waste.bookings)}</td>
            </tr>
            <tr>
              <td className={td}>أوراقها</td>
              <td className={`${td} ${num}`}>{formatCount(waste.sheets)}</td>
            </tr>
            <tr>
              <td className={td}>الأوراق التالفة</td>
              <td className={`${td} ${num}`}>
                {formatCount(waste.wastedSheets)}
                {rate !== null && <span className={hint}> ({rate}٪ من أوراقها)</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div>
        <h2 className="mb-2 font-bold">حركات المخزون حسب الصنف</h2>
        {data.items.length === 0 ? (
          <Empty />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={th}>الصنف</th>
                  <th className={th}>استلام</th>
                  <th className={th}>استهلاك</th>
                  <th className={th}>هدر</th>
                  <th className={th}>تسوية</th>
                  <th className={th}>الصافي</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.itemId}>
                    <td className={td}>
                      {r.itemName} <span className={hint}>({r.unit})</span>
                    </td>
                    <td className={`${td} ${num}`}>{formatCount(r.receive)}</td>
                    <td className={`${td} ${num}`}>{formatCount(r.consume)}</td>
                    <td className={`${td} ${num}`}>{formatCount(r.waste)}</td>
                    <td className={`${td} ${num}`}>{formatCount(r.adjust)}</td>
                    <td className={`${td} ${num} font-bold`}>{formatCount(r.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function PeakTable({ data }: { data: Ok<PeakHoursResult> }) {
  if (data.rows.length === 0) return <Empty />;
  const most = Math.max(...data.rows.map((r) => r.impressions));
  const label = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className={th}>الساعة</th>
            <th className={th}>الحجوزات</th>
            <th className={th}>الطبعات</th>
            <th className={th}>
              <span className="sr-only">الحصة من أكبر ساعة</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.hour}>
              <td className={`${td} ${num}`} dir="ltr">
                {label(r.hour)}
              </td>
              <td className={`${td} ${num}`}>{formatCount(r.bookings)}</td>
              <td className={`${td} ${num}`}>{formatCount(r.impressions)}</td>
              <td className={`${td} w-1/3`}>
                <div
                  className="h-3 rounded bg-primary"
                  style={{ width: `${most > 0 ? Math.max(2, Math.round((r.impressions / most) * 100)) : 0}%` }}
                  aria-hidden="true"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
