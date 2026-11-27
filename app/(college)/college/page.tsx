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
  booked: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  ready: "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  delivered: "bg-zinc-100 text-zinc-700 dark:bg-zinc-500/15 dark:text-zinc-300",
  cancelled: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  no_show: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

// The title and the button are the static shell; the list reads the session and the database, so it streams in
// behind its own <Suspense> (a navigation into this page is then instant).
export default function CollegePage({ searchParams }: PageProps<"/college">) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold md:text-2xl">حجوزاتي</h1>
        <div className="flex items-center gap-3">
          <Link href="/college/saturday" className="text-sm text-primary underline underline-offset-4">
            طلبات السبت
          </Link>
          <Link
            href="/college/book"
            className="glass-blue inline-flex h-11 items-center justify-center gap-2 px-5 font-semibold"
          >
            حجز جديد
          </Link>
        </div>
      </div>
      <Suspense fallback={<p className="text-muted-foreground">جارٍ التحميل…</p>}>
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
          className="notice notice--ok"
        >
          {justBooked ? "تم الحجز." : "تم تعديل الحجز."} رقم المرجع:{" "}
          <bdi dir="ltr" className="font-bold">{banner}</bdi>
          {examWarning && (
            <p className="mt-1 text-sm text-warning">
              تنبيه: يوم الحجز يصادف تاريخ الامتحان أو يأتي بعده.
            </p>
          )}
        </div>
      )}

      {!result.ok ? (
        <p role="alert" className="text-danger">
          تعذّر تحميل الحجوزات.
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed bg-card px-6 py-14 text-center text-muted-foreground">لا توجد حجوزات بعد. اضغط «حجز جديد» لإضافة أول حجز.</p>
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
    <li className="flex flex-col gap-2 rounded-2xl border border-border p-4 bg-card">
      <div className="flex items-center justify-between gap-3">
        <bdi dir="ltr" className="font-bold">
          {b.reference}
        </bdi>
        <span className={`rounded-full px-3 py-0.5 text-sm font-semibold ${STATUS_TONE[b.status]}`}>
          {STATUS_LABEL[b.status]}
        </span>
      </div>
      <p className="font-medium">{b.subject}</p>
      <p className="text-sm">
        {formatDay(dayOf(b.startsAt))}، من {timeOf(b.startsAt)} إلى {timeOf(b.endsAt)}
      </p>
      <p className="text-sm text-muted-foreground">
        {SERVICE_LABEL[b.serviceType]} · {b.copies} نسخة × {b.models} نموذج · {b.pagesPerModel} صفحة ·{" "}
        {SIDES_LABEL[b.sides]}
      </p>
      {b.delayedFrom && b.delayedFrom.getTime() !== b.startsAt.getTime() && (
        <p className="text-sm text-muted-foreground">أُرسل إشعار تأخير؛ كان الموعد من {timeOf(b.delayedFrom)}.</p>
      )}
      {b.needsReschedule && b.status === "booked" && (
        <p role="status" className="notice notice--warn">
          بانتظار قرار الإدارة بشأن موعد جديد.
        </p>
      )}
      <BookingActions bookingId={b.id} canEdit={b.canEdit} canDelay={b.canDelay} />
    </li>
  );
}
