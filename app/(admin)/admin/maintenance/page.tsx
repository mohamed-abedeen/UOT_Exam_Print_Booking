import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/admin/page-loading";
import { listMachines } from "@/lib/actions/machines";
import { listMaintenance } from "@/lib/actions/maintenance";
import { MaintenanceManager } from "./maintenance-manager";

export const metadata: Metadata = { title: "الصيانة" };

async function Maintenance() {
  const [machines, log] = await Promise.all([listMachines(), listMaintenance()]);
  // The clock is read after the session and the database were: this page is dynamic anyway.
  return (
    <MaintenanceManager
      machines={machines.filter((m) => m.archivedAt === null)}
      items={log.ok ? log.items : []}
      now={new Date()}
    />
  );
}

export default function MaintenancePage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Maintenance />
    </Suspense>
  );
}
