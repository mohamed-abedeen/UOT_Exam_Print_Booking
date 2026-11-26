import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/admin/page-loading";
import { listSaturdayRequests } from "@/lib/actions/saturday";
import { localDate } from "@/lib/scheduling/time";
import { SaturdayManager } from "./saturday-manager";

export const metadata: Metadata = { title: "طلبات السبت" };

async function Saturday() {
  const result = await listSaturdayRequests({});
  // The clock is read after the session and the database were: this page is dynamic anyway.
  return <SaturdayManager items={result.ok ? result.items : []} today={localDate(new Date())} />;
}

export default function SaturdayPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Saturday />
    </Suspense>
  );
}
