import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/admin/page-loading";
import { listMachines } from "@/lib/actions/machines";
import { MachinesManager } from "./machines-manager";

export const metadata: Metadata = { title: "الآلات" };

async function Machines() {
  return <MachinesManager machines={await listMachines()} />;
}

export default function MachinesPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Machines />
    </Suspense>
  );
}
