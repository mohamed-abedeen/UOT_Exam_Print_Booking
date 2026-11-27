// Step 4.2 — the reports screen: one date range, four tabs (contracts §4 "Reports and audit", §8.38).
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageLoading } from "@/components/admin/page-loading";
import { reportByCollege, reportByMachine, reportPeakHours, reportWasteAndStock } from "@/lib/actions/reports";
import { defaultRange } from "@/lib/reports/form";
import { localDate } from "@/lib/scheduling/time";
import { ReportsView } from "./reports-view";

export const metadata: Metadata = { title: "التقارير" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Reports searchParams={searchParams} />
    </Suspense>
  );
}

const loadAll = (from: string, to: string) =>
  Promise.all([reportByCollege(from, to), reportByMachine(from, to), reportWasteAndStock(from, to), reportPeakHours(from, to)]);

async function Reports({ searchParams }: { searchParams: SearchParams }) {
  await connection(); // "today" and the open maintenance windows are read per request
  const query = await searchParams;
  const fallback = defaultRange(localDate(new Date()));
  let { from, to } = fallback;
  if (typeof query.from === "string" && typeof query.to === "string") ({ from, to } = { from: query.from, to: query.to });
  let [colleges, machines, stock, peak] = await loadAll(from, to); // each action's first line is the role guard
  const badRange = !colleges.ok;
  if (!colleges.ok) {
    ({ from, to } = fallback);
    [colleges, machines, stock, peak] = await loadAll(from, to);
  }
  if (!colleges.ok || !machines.ok || !stock.ok || !peak.ok) return <p>تعذّر تحميل التقارير.</p>;
  return (
    <ReportsView from={from} to={to} badRange={badRange} colleges={colleges} machines={machines} stock={stock} peak={peak} />
  );
}
