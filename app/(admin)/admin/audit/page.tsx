// Step 4.3 — the audit log screen: filter by user, action and dates (contracts §4 "Reports and audit", §8.39).
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageLoading } from "@/components/admin/page-loading";
import { listAuditLog } from "@/lib/actions/audit";
import { listUsers } from "@/lib/actions/users";
import { defaultAuditRange } from "@/lib/audit/form";
import { localDate } from "@/lib/scheduling/time";
import { AuditView } from "./audit-view";

export const metadata: Metadata = { title: "سجل العمليات" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Audit searchParams={searchParams} />
    </Suspense>
  );
}

const text = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

async function Audit({ searchParams }: { searchParams: SearchParams }) {
  await connection(); // "today" is read per request
  const query = await searchParams;
  const fallback = defaultAuditRange(localDate(new Date()));
  // A first visit has no query: open on the last 7 days. A submitted form always sends all four keys, so empty dates
  // mean "no date limit".
  const submitted = ["user", "action", "from", "to"].some((key) => key in query);
  let form = submitted
    ? { user: text(query.user), action: text(query.action), from: text(query.from), to: text(query.to) }
    : { user: "", action: "", from: fallback.from, to: fallback.to };
  const toFilter = (f: typeof form) => ({
    userId: f.user ? Number(f.user) : undefined,
    action: f.action || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
  });
  const [users, first] = await Promise.all([listUsers(), listAuditLog(toFilter(form))]); // each action's first line is the role guard
  let result = first;
  const badFilter = !result.ok;
  if (!result.ok) {
    form = { user: "", action: "", from: fallback.from, to: fallback.to };
    result = await listAuditLog(toFilter(form));
  }
  if (!result.ok) return <p>تعذّر تحميل السجل.</p>;
  return (
    <AuditView
      form={form}
      badFilter={badFilter}
      users={users.map((u) => ({ id: u.id, label: `${u.fullName} (${u.username})` }))}
      rows={result.rows}
      truncated={result.truncated}
    />
  );
}
