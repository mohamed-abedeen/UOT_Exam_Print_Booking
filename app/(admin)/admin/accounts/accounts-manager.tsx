"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { button, buttonPrimary, errorText, field, td, th } from "@/components/admin/styles";
import type { CollegeRow } from "@/lib/actions/colleges";
import { createUser, resetUserPassword, setUserActive, updateUser, type UserRow } from "@/lib/actions/users";

const roleLabel = { college: "كلية", operator: "مشغّل", admin: "مسؤول" } as const;

const errorMessage: Record<string, string> = {
  validation: "اسم المستخدم من 3 إلى 32 حرفًا (أحرف لاتينية وأرقام و . _ -) والاسم الكامل مطلوب.",
  username_taken: "اسم المستخدم مستعمل.",
  college_taken: "للكلية حساب فعّال بالفعل.",
  college_not_found: "الكلية غير موجودة أو غير فعّالة.",
  not_found: "الحساب غير موجود.",
  self: "لا يمكنك تنفيذ هذا على حسابك.",
};

interface Notice {
  username: string;
  temporaryPassword: string;
}

export function AccountsManager({
  users,
  colleges,
  currentUserId,
}: {
  users: UserRow[];
  colleges: CollegeRow[];
  currentUserId: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [role, setRole] = useState<UserRow["role"]>("college");
  const [editing, setEditing] = useState<number | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) return setError(errorMessage[result.error ?? "validation"]);
      setError(null);
      onOk?.();
      router.refresh();
    });
  }

  function create(form: HTMLFormElement) {
    const formData = new FormData(form);
    const username = String(formData.get("username") ?? "");
    const collegeId = formData.get("collegeId");
    run(
      async () => {
        const result = await createUser({
          username,
          fullName: formData.get("fullName"),
          role,
          ...(role === "college" ? { collegeId: Number(collegeId) } : {}),
        });
        if (result.ok) setNotice({ username: username.trim(), temporaryPassword: result.temporaryPassword });
        return result;
      },
      () => form.reset(),
    );
  }

  function reset(u: UserRow) {
    if (!confirm(`إعادة تعيين كلمة مرور ${u.username}؟ ستنتهي جلساته.`)) return;
    run(async () => {
      const result = await resetUserPassword({ userId: u.id });
      if (result.ok) setNotice({ username: u.username, temporaryPassword: result.temporaryPassword });
      return result;
    });
  }

  const activeColleges = colleges.filter((c) => c.isActive);

  return (
    <section>
      <h1 className="mb-4 text-xl font-bold md:text-2xl">الحسابات</h1>

      {notice && (
        <div role="status" className="mb-4 max-w-xl notice notice--warn">
          <p>
            كلمة المرور المؤقتة للحساب <b dir="ltr">{notice.username}</b> (تظهر مرة واحدة فقط، ويغيّرها صاحب الحساب عند أول دخول):
          </p>
          <p className="my-2 font-mono text-lg" dir="ltr">
            {notice.temporaryPassword}
          </p>
          <button type="button" onClick={() => setNotice(null)} className={button}>
            تم النسخ
          </button>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault(); // not `action={…}`: React would clear the fields even when the save is refused
          create(e.currentTarget);
        }}
        className="mb-6 grid max-w-3xl grid-cols-1 gap-4 rounded-2xl border border-border p-4 sm:grid-cols-2 bg-card">
        <h2 className="font-bold sm:col-span-2">إضافة حساب</h2>
        <label className="flex flex-col gap-1">
          <span>اسم المستخدم</span>
          <input name="username" required minLength={3} maxLength={32} autoComplete="off" dir="ltr" className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span>الاسم الكامل</span>
          <input name="fullName" required maxLength={100} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span>الدور</span>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRow["role"])} className={field}>
            <option value="college">{roleLabel.college}</option>
            <option value="operator">{roleLabel.operator}</option>
            <option value="admin">{roleLabel.admin}</option>
          </select>
        </label>
        {role === "college" && (
          <label className="flex flex-col gap-1">
            <span>الكلية</span>
            <select name="collegeId" required defaultValue="" className={field}>
              <option value="" disabled>
                اختر الكلية
              </option>
              {activeColleges.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="sm:col-span-2">
          <button type="submit" disabled={pending} className={buttonPrimary}>
            إضافة
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className={`${errorText} mb-2`}>
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={th}>اسم المستخدم</th>
              <th className={th}>الاسم الكامل</th>
              <th className={th}>الدور</th>
              <th className={th}>الكلية</th>
              <th className={th}>الحالة</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const self = u.id === currentUserId;
              return (
                <tr key={u.id} className={u.isActive ? undefined : "opacity-60"}>
                  {editing === u.id ? (
                    <td className={td} colSpan={2}>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const formData = new FormData(e.currentTarget);
                          run(
                            () => updateUser({ userId: u.id, username: formData.get("username"), fullName: formData.get("fullName") }),
                            () => setEditing(null),
                          );
                        }}
                        className="flex flex-wrap gap-2"
                      >
                        <input name="username" required minLength={3} maxLength={32} defaultValue={u.username} aria-label="اسم المستخدم" dir="ltr" className={field} />
                        <input name="fullName" required maxLength={100} defaultValue={u.fullName} aria-label="الاسم الكامل" className={field} />
                        <button type="submit" disabled={pending} className={button}>
                          حفظ
                        </button>
                        <button type="button" onClick={() => setEditing(null)} className={button}>
                          إلغاء
                        </button>
                      </form>
                    </td>
                  ) : (
                    <>
                      <td className={td} dir="ltr">
                        {u.username}
                      </td>
                      <td className={td}>{u.fullName}</td>
                    </>
                  )}
                  <td className={td}>{roleLabel[u.role]}</td>
                  <td className={td}>{u.collegeName ?? "—"}</td>
                  <td className={td}>
                    {u.isActive ? "فعّال" : "موقوف"}
                    {u.mustChangePassword && " · كلمة مؤقتة"}
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    <button type="button" onClick={() => setEditing(u.id)} className={`${button} me-2`}>
                      تعديل
                    </button>
                    <button
                      type="button"
                      disabled={pending || self}
                      onClick={() => run(() => setUserActive({ userId: u.id, isActive: !u.isActive }))}
                      className={`${button} me-2`}
                    >
                      {u.isActive ? "إيقاف" : "تفعيل"}
                    </button>
                    <button type="button" disabled={pending || self} onClick={() => reset(u)} className={button}>
                      إعادة كلمة المرور
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
