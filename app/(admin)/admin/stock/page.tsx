import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/admin/page-loading";
import { listMachines } from "@/lib/actions/machines";
import { getPaperForecast, getStockAlerts, listInventory, listMachineParts, listMovements } from "@/lib/actions/stock";
import { StockManager } from "./stock-manager";

export const metadata: Metadata = { title: "المخزون" };

async function Stock() {
  const [inventory, alerts, forecast, parts, movements, machines] = await Promise.all([
    listInventory(),
    getStockAlerts(),
    getPaperForecast(),
    listMachineParts(),
    listMovements(),
    listMachines(),
  ]);
  return (
    <StockManager
      items={inventory.items}
      alerts={alerts.alerts}
      paperBalance={forecast.balance}
      days={forecast.days}
      parts={parts.ok ? parts.items : []}
      movements={movements.ok ? movements.items : []}
      machines={machines.filter((m) => m.archivedAt === null).map((m) => ({ id: m.id, name: m.name }))}
    />
  );
}

export default function StockPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Stock />
    </Suspense>
  );
}
