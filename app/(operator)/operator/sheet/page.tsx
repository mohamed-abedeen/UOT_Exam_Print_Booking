// Step 4.1 — the daily printed sheet for the operator (the admin has /admin/sheet; same component).
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { DailySheet } from "@/components/print/daily-sheet";
import { getDailySheet } from "@/lib/actions/bookings";
import { localDate } from "@/lib/scheduling/time";

export default function SheetPage({ searchParams }: PageProps<"/operator/sheet">) {
  return (
    <Suspense fallback={<p className="text-muted-foreground">جارٍ التحميل…</p>}>
      <Sheet searchParams={searchParams} />
    </Suspense>
  );
}

async function Sheet({ searchParams }: { searchParams: PageProps<"/operator/sheet">["searchParams"] }) {
  await connection(); // "today" is read per request
  const query = await searchParams;
  const today = localDate(new Date());
  const asked = typeof query.date === "string" ? query.date : today;
  let result = await getDailySheet(asked); // the action's first line is the role guard
  const badDate = !result.ok;
  if (!result.ok) result = await getDailySheet(today);
  if (!result.ok) return <p>تعذّر تحميل ورقة اليوم.</p>;
  return (
    <>
      <Link href="/operator" className="mb-3 inline-block text-sm underline underline-offset-4 print:hidden">
        قائمة اليوم
      </Link>
      <DailySheet action="/operator/sheet" date={result.date} rows={result.rows} badDate={badDate} />
    </>
  );
}
