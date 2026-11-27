"use client";
// The admin's stock screen (step 3.2, contracts §4 "Stock", §3.10, §8.31–35): the alerts, the balances of every item
// (receive, consume by hand, adjust, create, edit), the booked sheets of each coming day against the paper balance,
// the machine parts (parts-panel.tsx) and the movements log (movements-panel.tsx). A balance is always the sum of the
// item's movements on the server; this screen never computes one. After a write the page is read again.

import { useRouter } from "next/navigation";
import { Fragment, useState, useTransition } from "react";
import { button, buttonPrimary, errorText, field, hint, noticeOk, noticeWarn, td, th } from "@/components/admin/styles";
import { adjustStock, consumeStock, createInventoryItem, receiveStock, updateInventoryItem } from "@/lib/actions/stock";
import { formatDay } from "@/lib/bookings/format";
import type { InventoryItem, MachinePartRow, MovementRow, PaperDay, StockAlert } from "@/lib/stock";
import {
  alertLines,
  ALERT_KIND_LABEL,
  formatCount,
  INT_MAX,
  isPaperShort,
  KIND_LABEL,
  MOVE_MAX,
  parseSigned,
  parseWhole,
  type MachineOption,
} from "@/lib/stock/form";
import { MovementsPanel } from "./movements-panel";
import { PartsPanel } from "./parts-panel";

type MoveKind = "receive" | "consume" | "adjust";
type Action = { kind: MoveKind | "edit"; itemId: number } | { kind: "new" } | null;

const MOVE_TITLE: Record<MoveKind, string> = { receive: "استلام", consume: "صرف", adjust: "تسوية" };
const MOVE_ERROR: Record<string, string> = {
  validation: "تحقق من الكمية ومن الملاحظة (حتى 500 حرف).",
  not_found: "الصنف غير موجود.",
};
const ITEM_ERROR: Record<string, string> = {
  validation: "تحقق من الاسم (حتى 100 حرف) والوحدة (حتى 30 حرفًا) والحد الأدنى (عدد صحيح) ومن أن الآلة فعّالة.",
  duplicate: "يوجد صنف بهذا الاسم.",
  not_found: "الصنف غير موجود.",
  refused: "صنف الورق يبقى فعّالاً.",
  in_use: "قطعة مركّبة تستخدم هذا الصنف، فلا يُعطَّل ولا يُربط بآلة أخرى.",
};

function MovementForm({
  item,
  kind,
  onDone,
  onCancel,
}: {
  item: InventoryItem;
  kind: MoveKind;
  onDone: (notice: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const adjust = kind === "adjust";

  function submit() {
    const q = adjust ? parseSigned(qty) : parseWhole(qty, 1, MOVE_MAX);
    if (q === null) {
      return setError(
        adjust
          ? "اكتب عددًا صحيحًا غير صفر، موجبًا للزيادة وسالبًا للنقص (حتى 1,000,000)."
          : "اكتب عددًا صحيحًا من 1 إلى 1,000,000.",
      );
    }
    const text = note.trim();
    if (adjust && text === "") return setError("الملاحظة مطلوبة في التسوية: اذكر سببها.");
    setError(null);
    startTransition(async () => {
      const input = { itemId: item.id, quantity: q, ...(text ? { note: text } : {}) };
      const r =
        kind === "receive" ? await receiveStock(input) : kind === "consume" ? await consumeStock(input) : await adjustStock(input);
      if (!r.ok) return setError(MOVE_ERROR[r.error]);
      router.refresh();
      onDone(
        `سُجّل ${MOVE_TITLE[kind]} «${item.name}»: الرصيد الآن ${formatCount(r.balance)} ${item.unit}${r.balance < 0 ? " (سالب)" : ""}.`,
      );
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex max-w-xl flex-col gap-3 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <h3 className="font-bold">
        {MOVE_TITLE[kind]} — {item.name}
      </h3>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">الكمية ({item.unit})</span>
        <input
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          inputMode={adjust ? "text" : "numeric"}
          dir="ltr"
          maxLength={11}
          required
          className={`${field} w-40 text-left`}
        />
        {adjust && <span className={hint}>موجب يزيد الرصيد وسالب ينقصه، مثل 500 أو -120.</span>}
        {kind === "consume" && <span className={hint}>يُصرف يدويًا، مثل حبر أو رول ماستر جرى تغييره.</span>}
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">الملاحظة {adjust ? "(مطلوبة)" : "(اختيارية)"}</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} required={adjust} className={field} />
      </label>
      {error && (
        <p role="alert" className={errorText}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "جارٍ الحفظ…" : `سجّل ${MOVE_TITLE[kind]}`}
        </button>
        <button type="button" onClick={onCancel} className={button}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

function ItemForm({
  item,
  machines,
  onDone,
  onCancel,
}: {
  item: InventoryItem | null;
  machines: MachineOption[];
  onDone: (notice: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(item?.name ?? "");
  const [kind, setKind] = useState<"toner" | "master_roll" | "part">("toner");
  const [unit, setUnit] = useState(item?.unit ?? "");
  const [machineId, setMachineId] = useState(item?.machineId != null ? String(item.machineId) : "");
  const [min, setMin] = useState(item ? String(item.minQuantity) : "0");
  const [active, setActive] = useState(item?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const paper = item?.kind === "paper";
  // An item tied to a machine that was archived since keeps that machine in the list, marked.
  const options =
    item?.machineId != null && !machines.some((m) => m.id === item.machineId)
      ? [...machines, { id: item.machineId, name: `${item.machineName ?? item.machineId} (مؤرشفة)` }]
      : machines;

  function submit() {
    const n = name.trim();
    const u = unit.trim();
    const minQuantity = parseWhole(min, 0, INT_MAX);
    if (n === "" || n.length > 100 || u === "" || u.length > 30 || minQuantity === null) return setError(ITEM_ERROR.validation);
    const machine = machineId === "" ? null : Number(machineId);
    setError(null);
    startTransition(async () => {
      if (!item) {
        const r = await createInventoryItem({ name: n, kind, unit: u, machineId: machine, minQuantity });
        if (!r.ok) return setError(ITEM_ERROR[r.error]);
        router.refresh();
        return onDone(`أُضيف الصنف «${n}». استلم كمية له من زر «استلام».`);
      }
      const patch: Record<string, unknown> = {};
      if (n !== item.name) patch.name = n;
      if (u !== item.unit) patch.unit = u;
      if (!paper && machine !== item.machineId) patch.machineId = machine;
      if (minQuantity !== item.minQuantity) patch.minQuantity = minQuantity;
      if (!paper && active !== item.isActive) patch.isActive = active;
      if (Object.keys(patch).length === 0) return setError("لا تغيير للحفظ.");
      const r = await updateInventoryItem({ itemId: item.id, ...patch });
      if (!r.ok) return setError(ITEM_ERROR[r.error]);
      router.refresh();
      onDone(`حُفظ الصنف «${n}».`);
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex max-w-xl flex-col gap-3 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <h3 className="font-bold">{item ? `تعديل — ${item.name}` : "صنف جديد"}</h3>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">الاسم</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required className={field} />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">النوع</span>
          {item ? (
            <span className="py-2">{KIND_LABEL[item.kind]}</span>
          ) : (
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={field}>
              <option value="toner">{KIND_LABEL.toner}</option>
              <option value="master_roll">{KIND_LABEL.master_roll}</option>
              <option value="part">{KIND_LABEL.part}</option>
            </select>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">الوحدة</span>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={30} required className={`${field} w-32`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">الحد الأدنى</span>
          <input
            value={min}
            onChange={(e) => setMin(e.target.value)}
            inputMode="numeric"
            dir="ltr"
            maxLength={10}
            required
            className={`${field} w-32 text-left`}
          />
        </label>
      </div>
      {!paper && (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">الآلة (اختيارية)</span>
          <select value={machineId} onChange={(e) => setMachineId(e.target.value)} className={`${field} max-w-xs`}>
            <option value="">بلا آلة</option>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {item && !paper && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>فعّال (الصنف المعطّل لا ينبّه ولا يُربط بقطعة جديدة)</span>
        </label>
      )}
      {error && (
        <p role="alert" className={errorText}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "جارٍ الحفظ…" : item ? "احفظ" : "أضف الصنف"}
        </button>
        <button type="button" onClick={onCancel} className={button}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

function PaperDays({ days, balance }: { days: PaperDay[]; balance: number | null }) {
  const booked = days.filter((d) => d.sheets > 0);
  return (
    <div>
      <h2 className="mb-1 text-xl font-bold">الورق المحجوز مقابل الرصيد</h2>
      {balance === null ? (
        <p className={hint}>لا يوجد صنف ورق فعّال.</p>
      ) : (
        <>
          <p className={`${hint} mb-2`}>
            رصيد الورق الآن <span dir="ltr">{formatCount(balance)}</span> ورقة. كل يوم يُقارن بالرصيد وحده (حجوزات «محجوز» و«قيد
            التنفيذ» في الأيام القادمة؛ الأيام بلا حجوزات لا تظهر).
          </p>
          {booked.length === 0 ? (
            <p className="text-zinc-600 dark:text-zinc-400">لا حجوزات في الأيام القادمة.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full max-w-xl text-sm">
                <thead>
                  <tr>
                    <th className={th}>اليوم</th>
                    <th className={th}>الورق المحجوز</th>
                    <th className={th}>المتبقي من الرصيد</th>
                  </tr>
                </thead>
                <tbody>
                  {booked.map((d) => {
                    const short = isPaperShort(d, balance);
                    return (
                      <tr key={d.date} className={short ? "bg-red-50 dark:bg-red-950" : undefined}>
                        <td className={`${td} whitespace-nowrap`}>{formatDay(d.date)}</td>
                        <td className={td}>
                          <span dir="ltr">{formatCount(d.sheets)}</span>
                        </td>
                        <td className={td}>
                          <span dir="ltr" className={short ? "font-bold text-red-700 dark:text-red-400" : undefined}>
                            {formatCount(balance - d.sheets)}
                          </span>
                          {short && <span className={`${errorText} ms-2 font-bold`}>لا يكفي</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function StockManager({
  items,
  alerts,
  paperBalance,
  days,
  parts,
  movements,
  machines,
}: {
  items: InventoryItem[];
  alerts: StockAlert[];
  paperBalance: number | null;
  days: PaperDay[];
  parts: MachinePartRow[];
  movements: MovementRow[];
  machines: MachineOption[];
}) {
  const [action, setAction] = useState<Action>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lines = alertLines(alerts, items, parts, days, paperBalance);
  const nearEnd = new Set(alerts.filter((a) => a.kind === "part_near_end").map((a) => a.machinePartId));

  function done(text: string) {
    setAction(null);
    setNotice(text);
  }
  function open(next: Action) {
    setNotice(null);
    setAction(next);
  }

  return (
    <section className="flex flex-col gap-10">
      <div>
        <h1 className="mb-3 text-2xl font-bold">المخزون</h1>
        {lines.length === 0 ? (
          <p role="status" className={noticeOk}>
            لا تنبيهات: الأرصدة فوق حدودها والقطع في عمرها والورق يكفي الأيام القادمة.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="التنبيهات">
            {lines.map((l) => (
              <li key={l.key} className={noticeWarn}>
                <span className="font-bold">{ALERT_KIND_LABEL[l.kind]}: </span>
                {l.text}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-bold">الأرصدة</h2>
          {action?.kind !== "new" && (
            <button type="button" onClick={() => open({ kind: "new" })} className={buttonPrimary}>
              صنف جديد
            </button>
          )}
        </div>
        {notice && (
          <p role="status" className={`${noticeOk} mb-3`}>
            {notice}
          </p>
        )}
        {action?.kind === "new" && (
          <div className="mb-4">
            <ItemForm key="new" item={null} machines={machines} onDone={done} onCancel={() => setAction(null)} />
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>الصنف</th>
                <th className={th}>الرصيد</th>
                <th className={th}>الحد الأدنى</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const low = item.isActive && item.balance <= item.minQuantity;
                const mine = action && action.kind !== "new" && action.itemId === item.id ? action : null;
                return (
                  <Fragment key={item.id}>
                  <tr className={item.isActive ? undefined : "opacity-60"}>
                    <td className={td}>
                      <div className="font-medium">{item.name}</div>
                      <div className={hint}>
                        {KIND_LABEL[item.kind]}
                        {item.machineName ? ` · ${item.machineName}` : ""}
                        {item.isActive ? "" : " · معطّل"}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(["receive", "consume", "adjust"] as const).map((k) => (
                          <button key={k} type="button" onClick={() => open({ kind: k, itemId: item.id })} className={button}>
                            {MOVE_TITLE[k]}
                          </button>
                        ))}
                        <button type="button" onClick={() => open({ kind: "edit", itemId: item.id })} className={button}>
                          تعديل
                        </button>
                      </div>
                    </td>
                    <td className={`${td} whitespace-nowrap align-top`}>
                      <span dir="ltr" className={item.balance < 0 ? "font-bold text-red-700 dark:text-red-400" : undefined}>
                        {formatCount(item.balance)}
                      </span>{" "}
                      {item.unit}
                      {low && <span className={`${errorText} block font-bold`}>عند الحد</span>}
                    </td>
                    <td className={`${td} whitespace-nowrap align-top`}>
                      <span dir="ltr">{formatCount(item.minQuantity)}</span>
                    </td>
                  </tr>
                  {mine && (
                    <tr>
                      <td colSpan={3} className={td}>
                        {mine.kind === "edit" ? (
                          <ItemForm
                            key={`edit-${item.id}`}
                            item={item}
                            machines={machines}
                            onDone={done}
                            onCancel={() => setAction(null)}
                          />
                        ) : (
                          <MovementForm
                            key={`${mine.kind}-${item.id}`}
                            item={item}
                            kind={mine.kind}
                            onDone={done}
                            onCancel={() => setAction(null)}
                          />
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <PaperDays days={days} balance={paperBalance} />

      <PartsPanel parts={parts} items={items} machines={machines} nearEnd={nearEnd} />

      <MovementsPanel key={movements[0]?.id ?? 0} initial={movements} items={items} />
    </section>
  );
}
