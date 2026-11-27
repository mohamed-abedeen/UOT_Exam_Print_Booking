import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/admin/page-loading";
import { BookingForm } from "@/components/college/booking-form";
import { getBookingFormConfig } from "@/lib/actions/bookings";
import { listColleges } from "@/lib/actions/colleges";

export const metadata: Metadata = { title: "حجز لكلية" };

// The admin books on behalf of a college (step 2.7): the same form as the college's, with a college to pick.
async function Form() {
  const [config, colleges] = await Promise.all([getBookingFormConfig(), listColleges()]);
  return (
    <BookingForm config={config} onBehalf={{ colleges: colleges.filter((c) => c.isActive).map(({ id, name }) => ({ id, name })) }} />
  );
}

export default function AdminBookPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-bold md:text-2xl">حجز لكلية</h1>
      <Suspense fallback={<PageLoading />}>
        <Form />
      </Suspense>
    </div>
  );
}
