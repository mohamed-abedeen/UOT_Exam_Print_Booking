"use client";

import { useActionState } from "react";
import { changePasswordAction, type ChangePasswordFormState } from "./actions";

const field = "rounded-lg border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700";

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
    <form action={action} className="flex w-full max-w-sm flex-col gap-4">
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
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {messages[state.error]}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-zinc-900 px-5 py-2 font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        حفظ
      </button>
    </form>
  );
}
