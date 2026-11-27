import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "تسجيل الدخول" };

export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-5 rounded-3xl border border-border bg-card p-5 sm:p-6">
        <h1 className="text-xl font-bold md:text-2xl">تسجيل الدخول</h1>
        <LoginForm />
      </div>
    </main>
  );
}
