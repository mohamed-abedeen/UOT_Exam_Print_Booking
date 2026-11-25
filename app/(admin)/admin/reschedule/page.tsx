import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/admin/page-loading";
import { listNeedsReschedule } from "@/lib/actions/bookings";
import { listMachines } from "@/lib/actions/machines";
import { RescheduleManager } from "./reschedule-manager";

export const metadata: Metadata = { title: "إعادة الجدولة" };

async function Reschedule() {
  const [list, machines] = await Promise.all([listNeedsReschedule(), listMachines()]);
  return (
    <RescheduleManager bookings={list.bookings} machines={machines.filter((m) => m.archivedAt === null)} />
  );
}

export default function ReschedulePage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Reschedule />
    </Suspense>
  );
}
