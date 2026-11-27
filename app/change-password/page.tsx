import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getActor } from "@/lib/auth/guard";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "تغيير كلمة المرور" };

/** Sends a visitor with no session to /login. The action checks the session again. */
async function SignedInOnly() {
  if (!(await getActor())) redirect("/login");
  return null;
}

export default function ChangePasswordPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-5 rounded-3xl border border-border bg-card p-5 sm:p-6">
        <h1 className="text-xl font-bold md:text-2xl">تغيير كلمة المرور</h1>
        <Suspense fallback={null}>
          <SignedInOnly />
        </Suspense>
        <ChangePasswordForm />
      </div>
    </main>
  );
}
