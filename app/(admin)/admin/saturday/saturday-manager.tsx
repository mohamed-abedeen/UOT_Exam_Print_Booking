"use client";
// The admin's Saturday requests (step 2.7, contracts §4 "Saturday"): approve up to a quantity or reject, once. The
// list is filtered here (the server has no paging); a decision is an inline panel, like the machine and stop forms.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { button, buttonPrimary, errorText, field, td, th } from "@/components/admin/styles";
import { decideSaturdayRequest } from "@/lib/actions/saturday";
import { dayTime, digits, formatDay, SATURDAY_STATUS_LABEL, SATURDAY_STATUS_TONE } from "@/lib/bookings/format";
import type { SaturdayRequestItem, SaturdayStatus } from "@/lib/saturday";

const DECIDE_ERROR: Record<string, string> = {
  validation: "تحقق من الكمية: عدد صحيح موجب.",
  not_found: "الطلب غير موجود.",
  refused: "لا يمكن البت في هذا الطلب: تم البت فيه من قبل أو مضى يومه.",
};

type Filter = SaturdayStatus | "all";
type Deciding = { row: SaturdayRequestItem; mode: "approve" | "reject" };

function whole(text: string): number {
  const s = digits(text).trim();
  return /^\d{1,9}$/.test(s) ? Number(s) : Number.NaN;
}

function DecisionForm({
  deciding,
  onDone,
  onCancel,
}: {
  deciding: Deciding;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { row, mode } = deciding;

  function submit(formData: FormData) {
    const note = String(formData.get("note") ?? "");
    if (mode === "approve") {
      const approvedQuantity = whole(String(formData.get("quantity") ?? ""));
      if (!(Number.isInteger(approvedQuantity) && approvedQuantity >= 1)) return setError(DECIDE_ERROR.validation);
      startTransition(async () => {
        const result = await decideSaturdayRequest({ requestId: row.id, decision: "approve", approvedQuantity, note });
        if (!result.ok) return setError(DECIDE_ERROR[result.error]);
        router.refresh();
        onDone(`اعتُمد ${formatDay(row.date)} لكلية ${row.collegeName} حتى ${approvedQuantity}.`);
      });
    } else {
      startTransition(async () => {
        const result = await decideSaturdayRequest({ requestId: row.id, decision: "reject", note });
        if (!result.ok) return setError(DECIDE_ERROR[result.error]);
        router.refresh();
        onDone(`رُفض طلب ${row.collegeName} ليوم ${formatDay(row.date)}.`);
      });
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(new FormData(e.currentTarget));
      }}
      className="mb-6 flex max-w-2xl flex-col gap-4 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <h2 className="font-bold">
        {mode === "approve" ? "الموافقة على" : "رفض"} طلب {row.collegeName} ليوم {formatDay(row.date)}
      </h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        الكمية المتوقعة: {row.expectedQuantity} · السبب: {row.reason}
      </p>
      {mode === "approve" && (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">الكمية المعتمدة (عدد الأوجه المطبوعة)</span>
          <input
            name="quantity"
            defaultValue={row.expectedQuantity}
            inputMode="numeric"
            dir="ltr"
            required
            maxLength={9}
            className={`${field} text-left`}
          />
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            يُفتح اليوم لهذه الكلية فقط حتى هذه الكمية، ولا يُسحب الاعتماد بعد ذلك.
          </span>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">ملاحظة للكلية (اختيارية)</span>
        <textarea name="note" maxLength={500} rows={2} className={field} />
      </label>
      {error && (
        <p role="alert" className={errorText}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "جارٍ الحفظ…" : mode === "approve" ? "اعتمد" : "ارفض"}
        </button>
        <button type="button" disabled={pending} onClick={onCancel} className={button}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

export function SaturdayManager({ items, today }: { items: SaturdayRequestItem[]; today: string }) {
  const [filter, setFilter] = useState<Filter>("pending");
  const [collegeId, setCollegeId] = useState("");
  const [deciding, setDeciding] = useState<Deciding | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const colleges = [...new Map(items.map((r) => [r.collegeId, r.collegeName])).entries()];
  const shown = items.filter(
    (r) => (filter === "all" || r.status === filter) && (collegeId === "" || r.collegeId === Number(collegeId)),
  );
  const pendingCount = items.filter((r) => r.status === "pending" && r.date >= today).length;

  return (
    <section>
      <h1 className="mb-1 text-2xl font-bold">طلبات السبت</h1>
      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
        {pendingCount === 0 ? "لا توجد طلبات تنتظر القرار." : `${pendingCount} طلب ينتظر القرار.`}
      </p>

      {deciding && (
        <DecisionForm
          key={`${deciding.row.id}-${deciding.mode}`}
          deciding={deciding}
          onDone={(text) => {
            setNotice(text);
            setDeciding(null);
          }}
          onCancel={() => setDeciding(null)}
        />
      )}
      {notice && (
        <p role="status" className="mb-4 rounded-lg border border-green-600 bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950 dark:text-green-200">
          {notice}
        </p>
      )}

      <div className="mb-4 flex flex-wrap gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span>الحالة</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className={field}>
            <option value="pending">{SATURDAY_STATUS_LABEL.pending}</option>
            <option value="approved">{SATURDAY_STATUS_LABEL.approved}</option>
            <option value="rejected">{SATURDAY_STATUS_LABEL.rejected}</option>
            <option value="all">الكل</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span>الكلية</span>
          <select value={collegeId} onChange={(e) => setCollegeId(e.target.value)} className={field}>
            <option value="">كل الكليات</option>
            {colleges.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">لا توجد طلبات بهذا الفلتر.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>اليوم</th>
                <th className={th}>الكلية</th>
                <th className={th}>المتوقع</th>
                <th className={th}>المعتمد / المحجوز</th>
                <th className={th}>السبب</th>
                <th className={th}>الحالة</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const open = r.status === "pending" && r.date >= today;
                return (
                  <tr key={r.id}>
                    <td className={`${td} whitespace-nowrap`}>{formatDay(r.date)}</td>
                    <td className={td}>{r.collegeName}</td>
                    <td className={td}>{r.expectedQuantity}</td>
                    <td className={td}>
                      {r.status === "approved" ? `${r.approvedQuantity ?? 0} / ${r.usedImpressions ?? 0}` : "—"}
                    </td>
                    <td className={td}>
                      {r.reason}
                      {r.decisionNote && (
                        <span className="block text-zinc-600 dark:text-zinc-400">ملاحظتك: {r.decisionNote}</span>
                      )}
                    </td>
                    <td className={td}>
                      <span className={`rounded-full border px-2 py-0.5 ${SATURDAY_STATUS_TONE[r.status]}`}>
                        {SATURDAY_STATUS_LABEL[r.status]}
                      </span>
                      {r.status === "pending" && r.date < today && (
                        <span className="block text-zinc-600 dark:text-zinc-400">مضى يومه</span>
                      )}
                      {r.decidedAt && r.decidedByName && (
                        <span className="block text-zinc-600 dark:text-zinc-400">
                          {r.decidedByName} · {dayTime(r.decidedAt)}
                        </span>
                      )}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {open && (
                        <span className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setNotice(null);
                              setDeciding({ row: r, mode: "approve" });
                            }}
                            className={button}>
                            موافقة
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setNotice(null);
                              setDeciding({ row: r, mode: "reject" });
                            }}
                            className={button}>
                            رفض
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
