import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingForm } from "@/components/college/booking-form";
import { getBooking, getBookingFormConfig } from "@/lib/actions/bookings";
import { dayOf, timeOf } from "@/lib/bookings/format";

export const metadata: Metadata = { title: "تعديل حجز" };

// The title is the static shell; the form needs the booking, the settings and the session, so it streams in behind
// <Suspense>. The server decides again on save (status and deadline): this page only fills the form.
export default function EditBookingPage({ params }: PageProps<"/college/edit/[id]">) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link href="/college" className="text-sm text-primary underline">
        ← حجوزاتي
      </Link>
      <h1 className="text-xl font-bold md:text-2xl">تعديل حجز</h1>
      <Suspense fallback={<p className="text-muted-foreground">جارٍ التحميل…</p>}>
        <Form params={params} />
      </Suspense>
    </div>
  );
}

async function Form({ params }: { params: PageProps<"/college/edit/[id]">["params"] }) {
  const { id } = await params;
  const bookingId = /^\d{1,9}$/.test(id) ? Number(id) : 0;
  const [found, config] = await Promise.all([getBooking({ bookingId }), getBookingFormConfig()]);

  if (!found.ok) return <p role="alert" className="text-danger">الحجز غير موجود.</p>;
  const b = found.booking;
  if (b.status !== "booked") {
    return (
      <p role="alert" className="text-danger">
        لا يمكن تعديل هذا الحجز لأنه ليس في حالة «محجوز».
      </p>
    );
  }

  return (
    <>
      <p>
        رقم المرجع: <bdi dir="ltr" className="font-bold">{b.reference}</bdi> (لا يتغيّر بالتعديل)
      </p>
      <BookingForm
        config={config}
        edit={{
          bookingId: b.id,
          slot: { startsAt: b.startsAt, endsAt: b.endsAt },
          initial: {
            doctorName: b.doctorName,
            doctorPhone: b.doctorPhone,
            recipientName: b.recipientName,
            subject: b.subject,
            serviceType: b.serviceType,
            copies: String(b.copies),
            models: String(b.models),
            pagesPerModel: String(b.pagesPerModel),
            sides: b.sides,
            examDate: b.examDate ?? "",
            date: dayOf(b.startsAt),
            hour: String(Number(timeOf(b.startsAt).slice(0, 2))),
          },
        }}
      />
    </>
  );
}
