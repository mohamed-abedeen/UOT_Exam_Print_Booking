import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingActions } from "@/components/college/booking-actions";
import { listBookings } from "@/lib/actions/bookings";
import {
  dayOf,
  formatDay,
  SERVICE_LABEL,
  SIDES_LABEL,
  STATUS_LABEL,
  timeOf,
} from "@/lib/bookings/format";
import type { BookingListItem } from "@/lib/bookings/read";
import type { BookingStatus } from "@/lib/scheduling/types";

export const metadata: Metadata = { title: "حجوزاتي" };

const STATUS_TONE: Record<BookingStatus, string> = {
  booked: "border-sky-600 text-sky-800 dark:text-sky-300",
  in_progress: "border-amber-500 text-amber-800 dark:text-amber-300",
  ready: "border-green-600 text-green-800 dark:text-green-300",
  delivered: "border-zinc-400 text-zinc-700 dark:text-zinc-300",
  cancelled: "border-red-600 text-red-800 dark:text-red-300",
  no_show: "border-red-600 text-red-800 dark:text-red-300",
};

// The title and the button are the static shell; the list reads the session and the database, so it streams in
// behind its own <Suspense> (a navigation into this page is then instant).
export default function CollegePage({ searchParams }: PageProps<"/college">) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">حجوزاتي</h1>
        <div className="flex items-center gap-3">
          <Link href="/college/saturday" className="text-sm underline underline-offset-4">
            طلبات السبت
          </Link>
          <Link
            href="/college/book"
            className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            حجز جديد
          </Link>
        </div>
      </div>
      <Suspense fallback={<p className="text-zinc-600 dark:text-zinc-400">جارٍ التحميل…</p>}>
        <BookingList searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function BookingList({ searchParams }: { searchParams: PageProps<"/college">["searchParams"] }) {
  const query = await searchParams;
  const result = await listBookings({});
  const booked = typeof query.booked === "string" ? query.booked : null;
  const edited = typeof query.edited === "string" ? query.edited : null;
  const examWarning = query.examWarning === "1";
  const rows = result.ok ? result.bookings : [];
  // The banner is shown only for a reference that is really one of this college's bookings.
  const justBooked = booked !== null && rows.some((b) => b.reference === booked) ? booked : null;
  const justEdited = edited !== null && rows.some((b) => b.reference === edited) ? edited : null;
  const banner = justBooked ?? justEdited;

  return (
    <>
      {banner && (
        <div
          role="status"
          className="rounded-lg border border-green-600 bg-green-50 p-3 text-green-900 dark:bg-green-950 dark:text-green-200"
        >
          {justBooked ? "تم الحجز." : "تم تعديل الحجز."} رقم المرجع:{" "}
          <bdi dir="ltr" className="font-bold">{banner}</bdi>
          {examWarning && (
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
              تنبيه: يوم الحجز يصادف تاريخ الامتحان أو يأتي بعده.
            </p>
          )}
        </div>
      )}

      {!result.ok ? (
        <p role="alert" className="text-red-700 dark:text-red-400">
          تعذّر تحميل الحجوزات.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">لا توجد حجوزات بعد. اضغط «حجز جديد» لإضافة أول حجز.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((b) => (
            <BookingCard key={b.id} booking={b} />
          ))}
        </ul>
      )}
    </>
  );
}

function BookingCard({ booking: b }: { booking: BookingListItem }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <div className="flex items-center justify-between gap-3">
        <bdi dir="ltr" className="font-bold">
          {b.reference}
        </bdi>
        <span className={`rounded-full border px-3 py-0.5 text-sm ${STATUS_TONE[b.status]}`}>
          {STATUS_LABEL[b.status]}
        </span>
      </div>
      <p className="font-medium">{b.subject}</p>
      <p className="text-sm">
        {formatDay(dayOf(b.startsAt))}، من {timeOf(b.startsAt)} إلى {timeOf(b.endsAt)}
      </p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {SERVICE_LABEL[b.serviceType]} · {b.copies} نسخة × {b.models} نموذج · {b.pagesPerModel} صفحة ·{" "}
        {SIDES_LABEL[b.sides]}
      </p>
      {b.delayedFrom && b.delayedFrom.getTime() !== b.startsAt.getTime() && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">أُرسل إشعار تأخير؛ كان الموعد من {timeOf(b.delayedFrom)}.</p>
      )}
      {b.needsReschedule && b.status === "booked" && (
        <p role="status" className="rounded-lg border border-amber-500 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          بانتظار قرار الإدارة بشأن موعد جديد.
        </p>
      )}
      <BookingActions bookingId={b.id} canEdit={b.canEdit} canDelay={b.canDelay} />
    </li>
  );
}
