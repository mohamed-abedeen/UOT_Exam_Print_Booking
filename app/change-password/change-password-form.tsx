"use client";

import { useActionState } from "react";
import { changePasswordAction, type ChangePasswordFormState } from "./actions";

const field = "glass-field";

const messages: Record<NonNullable<ChangePasswordFormState>["error"], string> = {
  wrong_password: "كلمة المرور الحالية غير صحيحة.",
  validation: "كلمة المرور الجديدة يجب أن تكون من 10 إلى 128 حرفًا.",
  same_password: "كلمة المرور الجديدة يجب أن تختلف عن الحالية.",
  mismatch: "كلمتا المرور الجديدتان غير متطابقتين.",
  locked: "الحساب مقفل 15 دقيقة بعد 5 محاولات خاطئة. سجّل الدخول من جديد بعد انتهاء المدة.",
};

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, undefined);

  return (
    <form action={action} className="flex w-full flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span>كلمة المرور الحالية</span>
        <input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} dir="ltr" className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>كلمة المرور الجديدة (10 أحرف على الأقل)</span>
        <input name="newPassword" type="password" autoComplete="new-password" required minLength={10} maxLength={128} dir="ltr" className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>تأكيد كلمة المرور الجديدة</span>
        <input name="confirmPassword" type="password" autoComplete="new-password" required minLength={10} maxLength={128} dir="ltr" className={field} />
      </label>
      {state?.error && (
        <p role="alert" className="text-sm text-danger">
          {messages[state.error]}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="glass-blue inline-flex h-11 items-center justify-center gap-2 px-5 font-semibold disabled:opacity-60"
      >
        حفظ
      </button>
    </form>
  );
}
