// Step 4.3 — the audit table. Read-only: the filter is a plain GET back to the page, so a reload or a shared link shows
// the same rows. No client state: a row's details open with the browser's own <details>.
import { button, field, hint, noticeWarn, td, th } from "@/components/admin/styles";
import type { AuditRow } from "@/lib/audit";
import { ACTION_LABEL, actionLabel, AUDIT_LIMIT, AUDIT_ROLE_LABEL } from "@/lib/audit/form";
import { dayTime } from "@/lib/bookings/format";
import { formatCount } from "@/lib/stock/form";

export interface AuditForm {
  user: string;
  action: string;
  from: string;
  to: string;
}

export function AuditView({
  form,
  badFilter,
  users,
  rows,
  truncated,
}: {
  form: AuditForm;
  badFilter: boolean;
  users: { id: number; label: string }[];
  rows: AuditRow[];
  truncated: boolean;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-bold md:text-2xl">سجل العمليات</h1>
      <form method="get" action="/admin/audit" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          المستخدم
          <select name="user" defaultValue={form.user} className={field}>
            <option value="">الكل</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          الإجراء
          <select name="action" defaultValue={form.action} className={field}>
            <option value="">الكل</option>
            {Object.entries(ACTION_LABEL).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          من
          <input type="date" name="from" defaultValue={form.from} className={field} dir="ltr" />
        </label>
        <label className="flex flex-col gap-1">
          إلى
          <input type="date" name="to" defaultValue={form.to} className={field} dir="ltr" />
        </label>
        <button type="submit" className={button}>
          عرض
        </button>
      </form>
      {badFilter && <p className={noticeWarn}>التصفية غير صالحة، عُرضت آخر 7 أيام.</p>}
      <p className={hint}>التاريخان اختياريان؛ بتركهما فارغين يُعرض السجل كله. تُعرض أحدث {formatCount(AUDIT_LIMIT)} عملية.</p>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed bg-card px-6 py-14 text-center text-muted-foreground">لا توجد عمليات بهذه التصفية.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>الوقت</th>
                <th className={th}>المستخدم</th>
                <th className={th}>الإجراء</th>
                <th className={th}>الجهة</th>
                <th className={th}>الكلية</th>
                <th className={th}>عنوان IP</th>
                <th className={th}>التفاصيل</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={`${td} whitespace-nowrap tabular-nums`}>{dayTime(r.at)}</td>
                  <td className={td}>
                    {r.userId === null ? (
                      "النظام"
                    ) : (
                      <>
                        {r.userName}
                        {r.role && <span className={hint}> — {AUDIT_ROLE_LABEL[r.role]}</span>}
                      </>
                    )}
                  </td>
                  <td className={td}>
                    {actionLabel(r.action)}
                    {actionLabel(r.action) !== r.action && (
                      <div className={hint} dir="ltr">
                        {r.action}
                      </div>
                    )}
                  </td>
                  <td className={td} dir="ltr">
                    {r.entity}
                    {r.entityId !== null && ` #${r.entityId}`}
                  </td>
                  <td className={td}>{r.collegeName ?? "—"}</td>
                  <td className={`${td} tabular-nums`} dir="ltr">
                    {r.ip ?? "—"}
                  </td>
                  <td className={td}>
                    {Object.keys(r.details).length === 0 ? (
                      "—"
                    ) : (
                      <details>
                        <summary className="cursor-pointer">عرض</summary>
                        <pre className="mt-1 max-w-sm overflow-x-auto whitespace-pre-wrap text-xs" dir="ltr">
                          {JSON.stringify(r.details, null, 2)}
                        </pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && <p className={noticeWarn}>توجد عمليات أقدم؛ ضيّق التصفية بالتاريخ أو المستخدم أو الإجراء.</p>}
    </section>
  );
}
