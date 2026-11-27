"use client";

import { useActionState, useEffect } from "react";
import { loginAction } from "./actions";

const field = "glass-field";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  const to = state && "to" in state ? state.to : null;
  const error = state && "error" in state;

  // A full page load, not a client navigation: pages a previous user left in this tab (kept alive, hidden,
  // by Next) are dropped before the new user sees anything.
  useEffect(() => {
    if (to) window.location.replace(to);
  }, [to]);

  if (to) {
    return (
      <p role="status">
        جارٍ الدخول…{" "}
        <a href={to} className="text-primary underline">
          متابعة
        </a>
      </p>
    );
  }

  return (
    <form action={action} className="flex w-full flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span>اسم المستخدم</span>
        <input name="username" autoComplete="username" required maxLength={64} dir="ltr" className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span>كلمة المرور</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          dir="ltr"
          className={field}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          اسم المستخدم أو كلمة المرور غير صحيحة. بعد 5 محاولات خاطئة يُقفل الحساب 15 دقيقة.
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="glass-blue inline-flex h-11 items-center justify-center gap-2 px-5 font-semibold disabled:opacity-60"
      >
        دخول
      </button>
    </form>
  );
}
