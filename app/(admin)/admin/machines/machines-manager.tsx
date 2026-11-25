"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { button, buttonPrimary, errorText, field, td, th } from "@/components/admin/styles";
import { archiveMachine, createMachine, unarchiveMachine, updateMachine, type MachineRow } from "@/lib/actions/machines";

const typeLabel: Record<MachineRow["type"], string> = { laser: "ليزر", duplicator: "دوبليكيتور" };

const errorMessage: Record<string, string> = {
  validation: "تحقق من القيم: الحد الأعلى لا يقل عن الحد الأدنى، والأرقام موجبة.",
  name_taken: "يوجد آلة فعّالة بنفس الاسم.",
  not_found: "الآلة غير موجودة.",
};

type Editing = { kind: "new" } | { kind: "edit"; machine: MachineRow } | null;

/** What an edit or an archive did to future bookings the machine no longer takes (contracts §3.8, last bullet). */
type Touched = { moved: unknown[]; flagged: unknown[] };

function touchedNotice(result: Touched): string | null {
  const parts: string[] = [];
  if (result.moved.length > 0) parts.push(`نُقل ${result.moved.length} حجزًا إلى آلة أخرى في الوقت نفسه`);
  if (result.flagged.length > 0) parts.push(`${result.flagged.length} حجزًا لم يجد آلة بديلة وينتظر إعادة الجدولة`);
  return parts.length > 0 ? `${parts.join("، و")}.` : null;
}

function MachineForm({ editing, onDone }: { editing: NonNullable<Editing>; onDone: (touched?: Touched) => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const m = editing.kind === "edit" ? editing.machine : null;

  function submit(formData: FormData) {
    const num = (key: string) => Number(formData.get(key));
    const max = String(formData.get("maxSheets") ?? "").trim();
    const fields = {
      name: formData.get("name"),
      model: formData.get("model"),
      type: formData.get("type"),
      minSheets: num("minSheets"),
      maxSheets: max === "" ? null : Number(max),
      supportsDuplex: formData.get("supportsDuplex") === "on",
      speedPerHour: num("speedPerHour"),
      setupMinutesPerModel: num("setupMinutesPerModel"),
      priority: num("priority"),
    };
    startTransition(async () => {
      const result = m ? await updateMachine({ machineId: m.id, fields }) : await createMachine(fields);
      if (!result.ok) return setError(errorMessage[result.error]);
      setError(null);
      router.refresh();
      onDone("moved" in result ? result : undefined);
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault(); // not `action={…}`: React would clear the fields even when the save is refused
        submit(new FormData(e.currentTarget));
      }}
      className="mb-6 grid max-w-3xl grid-cols-1 gap-4 rounded-lg border border-zinc-300 p-4 sm:grid-cols-2 dark:border-zinc-700">
      <h2 className="font-bold sm:col-span-2">{m ? `تعديل: ${m.name}` : "إضافة آلة"}</h2>
      <label className="flex flex-col gap-1">
        <span>الاسم</span>
        <input name="name" required maxLength={100} defaultValue={m?.name} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>الطراز</span>
        <input name="model" required maxLength={100} defaultValue={m?.model} dir="ltr" className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>النوع</span>
        <select name="type" defaultValue={m?.type ?? "laser"} className={field}>
          <option value="laser">{typeLabel.laser}</option>
          <option value="duplicator">{typeLabel.duplicator}</option>
        </select>
      </label>
      <label className="flex items-center gap-2 pt-6">
        <input name="supportsDuplex" type="checkbox" defaultChecked={m?.supportsDuplex ?? false} />
        <span>تدعم الطباعة على الوجهين</span>
      </label>
      <label className="flex flex-col gap-1">
        <span>أقل عدد وجوه (مرات طباعة)</span>
        <input name="minSheets" type="number" required min={1} defaultValue={m?.minSheets ?? 1} dir="ltr" className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>أكثر عدد وجوه (فارغ = بلا حد)</span>
        <input name="maxSheets" type="number" min={1} defaultValue={m?.maxSheets ?? ""} dir="ltr" className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>السرعة (وجه في الساعة)</span>
        <input name="speedPerHour" type="number" required min={1} defaultValue={m?.speedPerHour} dir="ltr" className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>دقائق التجهيز لكل نموذج</span>
        <input name="setupMinutesPerModel" type="number" required min={0} defaultValue={m?.setupMinutesPerModel ?? 5} dir="ltr" className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>الأولوية (الأقل أولًا)</span>
        <input name="priority" type="number" required min={0} defaultValue={m?.priority ?? 100} dir="ltr" className={field} />
      </label>
      {error && (
        <p role="alert" className={`${errorText} sm:col-span-2`}>
          {error}
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonPrimary}>
          حفظ
        </button>
        <button type="button" onClick={() => onDone()} className={button}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

export function MachinesManager({ machines }: { machines: MachineRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function toggle(machine: MachineRow) {
    startTransition(async () => {
      const result = machine.archivedAt ? await unarchiveMachine({ machineId: machine.id }) : await archiveMachine({ machineId: machine.id });
      setError(result.ok ? null : errorMessage[result.error]);
      setNotice(result.ok ? touchedNotice(result) : null);
      router.refresh();
    });
  }

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">الآلات</h1>
        {!editing && (
          <button type="button" onClick={() => setEditing({ kind: "new" })} className={buttonPrimary}>
            إضافة آلة
          </button>
        )}
      </div>
      {editing && (
        <MachineForm
          key={editing.kind === "edit" ? editing.machine.id : "new"}
          editing={editing}
          onDone={(touched) => {
            setEditing(null);
            setNotice(touched ? touchedNotice(touched) : null);
          }}
        />
      )}
      {notice && (
        <p role="status" className="mb-3 rounded-lg border border-amber-500 bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          بسبب هذا التغيير: {notice}{" "}
          <Link href="/admin/reschedule" className="font-medium underline">
            قائمة إعادة الجدولة
          </Link>
        </p>
      )}
      {error && (
        <p role="alert" className={`${errorText} mb-2`}>
          {error}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={th}>الاسم</th>
              <th className={th}>الطراز</th>
              <th className={th}>النوع</th>
              <th className={th}>المدى (وجوه)</th>
              <th className={th}>وجهان</th>
              <th className={th}>السرعة / ساعة</th>
              <th className={th}>تجهيز (د)</th>
              <th className={th}>الأولوية</th>
              <th className={th}>الحالة</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {machines.map((m) => (
              <tr key={m.id} className={m.archivedAt ? "opacity-60" : undefined}>
                <td className={td}>{m.name}</td>
                <td className={td} dir="ltr">
                  {m.model}
                </td>
                <td className={td}>{typeLabel[m.type]}</td>
                <td className={td}>
                  {m.minSheets}–{m.maxSheets ?? "∞"}
                </td>
                <td className={td}>{m.supportsDuplex ? "نعم" : "لا"}</td>
                <td className={td}>{m.speedPerHour}</td>
                <td className={td}>{m.setupMinutesPerModel}</td>
                <td className={td}>{m.priority}</td>
                <td className={td}>{m.archivedAt ? "مؤرشفة" : "فعّالة"}</td>
                <td className={`${td} whitespace-nowrap`}>
                  <button type="button" onClick={() => setEditing({ kind: "edit", machine: m })} className={`${button} me-2`}>
                    تعديل
                  </button>
                  <button type="button" disabled={pending} onClick={() => toggle(m)} className={button}>
                    {m.archivedAt ? "إلغاء الأرشفة" : "أرشفة"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
