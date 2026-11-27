"use client";
// The movements log of the stock screen (step 3.2, contracts §8.35): newest first, at most 500 rows, filtered by item
// and by business dates (both ends inclusive). The page gives the unfiltered list; "عرض" asks the server again. The
// parent re-keys this panel when a new movement exists, which drops an old filter and shows the fresh list.

import { useState, useTransition } from "react";
import { button, errorText, field, hint, td, th } from "@/components/admin/styles";
import { listMovements } from "@/lib/actions/stock";
import { dayTime } from "@/lib/bookings/format";
import type { InventoryItem, MovementRow } from "@/lib/stock";
import { formatCount, MOVEMENT_LABEL, MOVEMENTS_LIMIT } from "@/lib/stock/form";

export function MovementsPanel({ initial, items }: { initial: MovementRow[]; items: InventoryItem[] }) {
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState(initial);
  const [itemId, setItemId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  function show() {
    if (from !== "" && to !== "" && from > to) return setError("«من» بعد «إلى»: صحّح التاريخين.");
    setError(null);
    startTransition(async () => {
      const r = await listMovements({
        ...(itemId !== "" ? { itemId: Number(itemId) } : {}),
        ...(from !== "" ? { from } : {}),
        ...(to !== "" ? { to } : {}),
      });
      if (!r.ok) return setError("تعذّر قراءة الفلتر: تحقق من التاريخين.");
      setRows(r.items);
    });
  }

  return (
    <div>
      <h2 className="mb-3 text-[15px] font-bold">سجل الحركات</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          show();
        }}
        className="mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">الصنف</span>
          <select value={itemId} onChange={(e) => setItemId(e.target.value)} className={`${field} max-w-xs`}>
            <option value="">كل الأصناف</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">من</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">إلى</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" className={field} />
        </label>
        <button type="submit" disabled={pending} className={button}>
          {pending ? "جارٍ القراءة…" : "عرض"}
        </button>
      </form>
      {error && (
        <p role="alert" className={`${errorText} mb-2`}>
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed bg-card px-6 py-14 text-center text-muted-foreground">لا حركات.</p>
      ) : (
        <>
          {rows.length >= MOVEMENTS_LIMIT && (
            <p className={`${hint} mb-2`}>تظهر أحدث {formatCount(MOVEMENTS_LIMIT)} حركة فقط؛ ضيّق الفلتر لرؤية غيرها.</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={th}>الحركة</th>
                  <th className={th}>الكمية</th>
                  <th className={th}>التفاصيل</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td className={td}>
                      <div className="font-medium">
                        {MOVEMENT_LABEL[m.type]} — {m.itemName}
                      </div>
                      <div className={hint}>{dayTime(m.createdAt)}</div>
                    </td>
                    <td className={`${td} whitespace-nowrap align-top`}>
                      <span dir="ltr">
                        {m.quantity > 0 ? "+" : ""}
                        {formatCount(m.quantity)}
                      </span>
                    </td>
                    <td className={`${td} align-top`}>
                      <div>{m.createdByName}</div>
                      {m.bookingReference && (
                        <div className={hint}>
                          الحجز <span dir="ltr">{m.bookingReference}</span>
                        </div>
                      )}
                      {m.note && <div className={hint}>{m.note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
