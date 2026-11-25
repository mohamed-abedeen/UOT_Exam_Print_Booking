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
      <Link href="/college" className="text-sm underline">
        ← حجوزاتي
      </Link>
      <h1 className="text-2xl font-bold">حجز جديد</h1>
      <Suspense fallback={<p className="text-zinc-600 dark:text-zinc-400">جارٍ التحميل…</p>}>
        <Form />
      </Suspense>
    </div>
  );
}

async function Form() {
  return <BookingForm config={await getBookingFormConfig()} />;
}
