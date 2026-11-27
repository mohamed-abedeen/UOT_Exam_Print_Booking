"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { button, buttonPrimary, errorText, field, td, th } from "@/components/admin/styles";
import { createCollege, setCollegeActive, updateCollege, type CollegeRow } from "@/lib/actions/colleges";

const errorMessage: Record<string, string> = {
  validation: "الاسم مطلوب (حتى 100 حرف).",
  name_taken: "يوجد كلية بنفس الاسم.",
  not_found: "الكلية غير موجودة.",
};

export function CollegesManager({ colleges }: { colleges: CollegeRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) return setError(errorMessage[result.error ?? "validation"]);
      setError(null);
      onOk?.();
      router.refresh();
    });
  }

  return (
    <section>
      <h1 className="mb-4 text-xl font-bold md:text-2xl">الكليات</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault(); // not `action={…}`: React would clear the field even when the save is refused
          const form = e.currentTarget;
          run(() => createCollege({ name: new FormData(form).get("name") }), () => form.reset());
        }}
        className="mb-4 flex max-w-md gap-2"
      >
        <input name="name" required maxLength={100} placeholder="اسم كلية جديدة" aria-label="اسم كلية جديدة" className={`${field} flex-1`} />
        <button type="submit" disabled={pending} className={buttonPrimary}>
          إضافة
        </button>
      </form>
      {error && (
        <p role="alert" className={`${errorText} mb-2`}>
          {error}
        </p>
      )}
      <table className="w-full max-w-2xl text-sm">
        <thead>
          <tr>
            <th className={th}>الكلية</th>
            <th className={th}>الحالة</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody>
          {colleges.map((c) => (
            <tr key={c.id} className={c.isActive ? undefined : "opacity-60"}>
              <td className={td}>
                {renaming === c.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = new FormData(e.currentTarget).get("name");
                      run(() => updateCollege({ collegeId: c.id, name }), () => setRenaming(null));
                    }}
                    className="flex gap-2"
                  >
                    <input name="name" required maxLength={100} defaultValue={c.name} aria-label="الاسم" className={`${field} flex-1`} />
                    <button type="submit" disabled={pending} className={button}>
                      حفظ
                    </button>
                    <button type="button" onClick={() => setRenaming(null)} className={button}>
                      إلغاء
                    </button>
                  </form>
                ) : (
                  c.name
                )}
              </td>
              <td className={td}>{c.isActive ? "فعّالة" : "غير فعّالة"}</td>
              <td className={`${td} whitespace-nowrap`}>
                <button type="button" onClick={() => setRenaming(c.id)} className={`${button} me-2`}>
                  تعديل الاسم
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => setCollegeActive({ collegeId: c.id, isActive: !c.isActive }))}
                  className={button}
                >
                  {c.isActive ? "إيقاف" : "تفعيل"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-sm text-muted-foreground">إيقاف الكلية يوقف حسابها ويُنهي جلساته. تفعيل الكلية لا يفعّل الحساب: من صفحة الحسابات.</p>
    </section>
  );
}
