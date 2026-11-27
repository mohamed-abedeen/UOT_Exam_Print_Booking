import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingForm } from "@/components/college/booking-form";
import { getBookingFormConfig } from "@/lib/actions/bookings";

export const metadata: Metadata = { title: "حجز جديد" };

// The title is the static shell; the form needs the settings and the session, so it streams in behind <Suspense>.
export default function BookPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link href="/college" className="text-sm text-primary underline">
        ← حجوزاتي
      </Link>
      <h1 className="text-xl font-bold md:text-2xl">حجز جديد</h1>
      <Suspense fallback={<p className="text-muted-foreground">جارٍ التحميل…</p>}>
        <Form />
      </Suspense>
    </div>
  );
}

async function Form() {
  return <BookingForm config={await getBookingFormConfig()} />;
}
