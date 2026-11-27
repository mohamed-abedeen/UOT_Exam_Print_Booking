// Step 4.1 — the daily printed sheet for the admin (the operator has /operator/sheet; same component).
import { connection } from "next/server";
import { Suspense } from "react";
import { DailySheet } from "@/components/print/daily-sheet";
import { getDailySheet } from "@/lib/actions/bookings";
import { localDate } from "@/lib/scheduling/time";

export default function SheetPage({ searchParams }: PageProps<"/admin/sheet">) {
  return (
    <Suspense fallback={<p className="text-muted-foreground">جارٍ التحميل…</p>}>
      <Sheet searchParams={searchParams} />
    </Suspense>
  );
}

async function Sheet({ searchParams }: { searchParams: PageProps<"/admin/sheet">["searchParams"] }) {
  await connection(); // "today" is read per request
  const query = await searchParams;
  const today = localDate(new Date());
  const asked = typeof query.date === "string" ? query.date : today;
  let result = await getDailySheet(asked); // the action's first line is the role guard
  const badDate = !result.ok;
  if (!result.ok) result = await getDailySheet(today);
  if (!result.ok) return <p>تعذّر تحميل ورقة اليوم.</p>;
  return <DailySheet action="/admin/sheet" date={result.date} rows={result.rows} badDate={badDate} />;
}
