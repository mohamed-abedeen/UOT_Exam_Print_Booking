"use client";
// The machine parts of the stock screen (step 3.2, contracts §8.34): the installed parts with their life counters,
// add a part to a machine, and replace one (the counter starts again at 0 on a new row; a part with a stock item also
// takes one of it out of stock). The server decides every refusal; a replace of a row already replaced says so.

import { useRouter } from "next/navigation";
import { Fragment, useState, useTransition } from "react";
import { button, buttonPrimary, errorText, field, hint, noticeOk, noticeWarn, td, th } from "@/components/admin/styles";
import { addMachinePart, replaceMachinePart } from "@/lib/actions/stock";
import { dayOf } from "@/lib/bookings/format";
import type { InventoryItem, MachinePartRow } from "@/lib/stock";
import { formatCount, INT_MAX, parseWhole, percentUsed, type MachineOption } from "@/lib/stock/form";

const ADD_ERROR = "تحقق من الاسم (حتى 100 حرف) ومن العمر (عدد صحيح موجب) ومن أن الآلة فعّالة وصنف المخزون صالح لها.";
const REPLACE_ERROR: Record<string, string> = {
  validation: "تحقق من العمر الجديد (عدد صحيح موجب).",
  not_found: "القطعة غير موجودة.",
  refused: "استُبدلت هذه القطعة من قبل. حُدّثت القائمة.",
};

function AddPartForm({
  machines,
  items,
  onDone,
  onCancel,
}: {
  machines: MachineOption[];
  items: InventoryItem[];
  onDone: (notice: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [machineId, setMachineId] = useState(machines[0] ? String(machines[0].id) : "");
  const [name, setName] = useState("");
  const [life, setLife] = useState("");
  const [itemId, setItemId] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A stock item of a part: active, kind part, on no machine or on the machine picked (contracts §8.34).
  const choices = items.filter(
    (i) => i.kind === "part" && i.isActive && (i.machineId === null || String(i.machineId) === machineId),
  );
  const chosen = choices.some((i) => String(i.id) === itemId) ? itemId : "";

  function submit() {
    const impressions = parseWhole(life, 1, INT_MAX);
    const n = name.trim();
    if (machineId === "" || n === "" || n.length > 100 || impressions === null) return setError(ADD_ERROR);
    setError(null);
    startTransition(async () => {
      const r = await addMachinePart({
        machineId: Number(machineId),
        name: n,
        lifeImpressions: impressions,
        inventoryItemId: chosen === "" ? null : Number(chosen),
      });
      if (!r.ok) return setError(ADD_ERROR);
      router.refresh();
      onDone(`رُكّبت القطعة «${n}» والعدّاد عند 0.`);
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="mb-4 flex max-w-xl flex-col gap-3 rounded-2xl border border-border p-4 bg-card">
      <h3 className="font-bold">تركيب قطعة على آلة</h3>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">الآلة</span>
        <select value={machineId} onChange={(e) => setMachineId(e.target.value)} required className={`${field} max-w-xs`}>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className="text-sm font-medium">اسم القطعة</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">العمر (أوجه مطبوعة)</span>
          <input
            value={life}
            onChange={(e) => setLife(e.target.value)}
            inputMode="numeric"
            dir="ltr"
            maxLength={10}
            required
            className={`${field} w-40 text-left`}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">صنف المخزون (اختياري)</span>
        <select value={chosen} onChange={(e) => setItemId(e.target.value)} className={`${field} max-w-xs`}>
          <option value="">بلا صنف</option>
          {choices.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <span className={hint}>إن رُبطت بصنف، يصرف الاستبدال واحدًا منه. أنشئ الصنف أولاً من «صنف جديد» بنوع قطعة غيار.</span>
      </label>
      {error && (
        <p role="alert" className={errorText}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "جارٍ الحفظ…" : "ركّب القطعة"}
        </button>
        <button type="button" onClick={onCancel} className={button}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

function ReplaceForm({
  part,
  onDone,
  onCancel,
}: {
  part: MachinePartRow;
  onDone: (notice: string, warn?: boolean) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [life, setLife] = useState(String(part.lifeImpressions));
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const impressions = parseWhole(life, 1, INT_MAX);
    if (impressions === null) return setError(REPLACE_ERROR.validation);
    setError(null);
    startTransition(async () => {
      const r = await replaceMachinePart({
        partId: part.id,
        ...(impressions !== part.lifeImpressions ? { lifeImpressions: impressions } : {}),
      });
      if (!r.ok) {
        if (r.error === "validation") return setError(REPLACE_ERROR.validation);
        // The part is gone from the list after the refresh, and this form with it: the reason goes to the panel.
        router.refresh();
        return onDone(REPLACE_ERROR[r.error], true);
      }
      router.refresh();
      onDone(
        `استُبدلت القطعة «${part.name}» في ${part.machineName}، والعدّاد عند 0${r.movementId !== null ? ` وصُرف واحد من «${part.inventoryItemName}»` : ""}.`,
      );
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex max-w-xl flex-col gap-3 rounded-2xl border border-border p-4 bg-card">
      <h3 className="font-bold">
        استبدال «{part.name}» — {part.machineName}
      </h3>
      <p className={hint}>
        تُغلق القطعة الحالية (استُهلك منها <span dir="ltr">{formatCount(part.impressionsUsed)}</span>) وتُفتح قطعة جديدة والعدّاد عند 0
        {part.inventoryItemName ? `، ويُصرف واحد من «${part.inventoryItemName}»` : ""}.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">عمر القطعة الجديدة (أوجه مطبوعة)</span>
        <input
          value={life}
          onChange={(e) => setLife(e.target.value)}
          inputMode="numeric"
          dir="ltr"
          maxLength={10}
          required
          className={`${field} w-40 text-left`}
        />
        <span className={hint}>يبقى عمر القطعة الحالية ما لم تغيّره.</span>
      </label>
      {error && (
        <p role="alert" className={errorText}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "جارٍ الحفظ…" : "أكّد الاستبدال"}
        </button>
        <button type="button" onClick={onCancel} className={button}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

export function PartsPanel({
  parts,
  items,
  machines,
  nearEnd,
}: {
  parts: MachinePartRow[];
  items: InventoryItem[];
  machines: MachineOption[];
  nearEnd: Set<number | undefined>;
}) {
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ text: string; warn: boolean } | null>(null);

  function done(text: string, warn = false) {
    setAdding(false);
    setReplacing(null);
    setNotice({ text, warn });
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-bold">قطع الآلات</h2>
        {!adding && machines.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setReplacing(null);
              setAdding(true);
            }}
            className={buttonPrimary}>
            تركيب قطعة
          </button>
        )}
      </div>
      {notice && (
        <p role="status" className={`${notice.warn ? noticeWarn : noticeOk} mb-3`}>
          {notice.text}
        </p>
      )}
      {adding && <AddPartForm machines={machines} items={items} onDone={done} onCancel={() => setAdding(false)} />}
      {parts.length === 0 ? (
        <p className="rounded-2xl border border-dashed bg-card px-6 py-14 text-center text-muted-foreground">لا قطع مركّبة. ركّب قطعة لتُحسب أوجه الطباعة على عمرها.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>القطعة</th>
                <th className={th}>الاستهلاك</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => {
                const near = nearEnd.has(p.id);
                return (
                  <Fragment key={p.id}>
                    <tr>
                      <td className={td}>
                        <div className="font-medium">{p.name}</div>
                        <div className={hint}>
                          {p.machineName}
                          {p.inventoryItemName ? ` · ${p.inventoryItemName}` : ""} · رُكّبت {dayOf(p.installedAt)}
                        </div>
                        <div className="mt-2">
                          <button
                            type="button"
                            onClick={() => {
                              setNotice(null);
                              setAdding(false);
                              setReplacing(p.id);
                            }}
                            className={button}>
                            استبدال
                          </button>
                        </div>
                      </td>
                      <td className={`${td} whitespace-nowrap align-top`}>
                        <span dir="ltr">
                          {formatCount(p.impressionsUsed)} / {formatCount(p.lifeImpressions)}
                        </span>
                        <div className={near ? `${errorText} font-bold` : hint}>
                          {percentUsed(p.impressionsUsed, p.lifeImpressions)}٪{near ? " — قاربت نهاية عمرها" : ""}
                        </div>
                      </td>
                    </tr>
                    {replacing === p.id && (
                      <tr>
                        <td colSpan={2} className={td}>
                          <ReplaceForm key={p.id} part={p} onDone={done} onCancel={() => setReplacing(null)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
