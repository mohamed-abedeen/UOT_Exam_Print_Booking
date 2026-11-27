import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SaturdayRequestForm } from "@/components/college/saturday-request-form";
import { getBookingFormConfig } from "@/lib/actions/bookings";
import { listSaturdayRequests } from "@/lib/actions/saturday";
import { formatDay, SATURDAY_STATUS_LABEL, SATURDAY_STATUS_TONE } from "@/lib/bookings/format";

export const metadata: Metadata = { title: "طلبات السبت" };

// The title is the static shell; the form and the list read the session and the database, so they stream in.
export default function SaturdayPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link href="/college" className="text-sm text-primary underline">
        ← حجوزاتي
      </Link>
      <h1 className="text-xl font-bold md:text-2xl">طلبات السبت</h1>
      <Suspense fallback={<p className="text-muted-foreground">جارٍ التحميل…</p>}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const [config, result] = await Promise.all([getBookingFormConfig(), listSaturdayRequests({})]);
  const rows = result.ok ? result.items : [];
  return (
    <>
      {config.workingWeekdays.includes(6) ? (
        <p className="rounded-2xl border border-border p-3 text-sm bg-card">
          السبت يوم عمل عادي في الإعدادات الحالية، فلا حاجة إلى طلب.
        </p>
      ) : (
        <SaturdayRequestForm today={config.today} workingWeekdays={config.workingWeekdays} />
      )}

      <h2 className="mt-2 text-[15px] font-bold">طلباتي</h2>
      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed bg-card px-6 py-14 text-center text-muted-foreground">لا توجد طلبات بعد.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 rounded-2xl border border-border p-4 bg-card">
              <div className="flex items-center justify-between gap-3">
                <span className="font-bold">{formatDay(r.date)}</span>
                <span className={`rounded-full px-3 py-0.5 text-sm font-semibold ${SATURDAY_STATUS_TONE[r.status]}`}>
                  {SATURDAY_STATUS_LABEL[r.status]}
                </span>
              </div>
              <p className="text-sm">الكمية المتوقعة: {r.expectedQuantity}</p>
              {r.status === "approved" && r.approvedQuantity !== null && (
                <p className="text-sm">
                  الكمية المعتمدة: {r.approvedQuantity}، المحجوز منها: {r.usedImpressions ?? 0}
                </p>
              )}
              <p className="text-sm text-muted-foreground">السبب: {r.reason}</p>
              {r.decisionNote && <p className="text-sm">ملاحظة المسؤول: {r.decisionNote}</p>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
