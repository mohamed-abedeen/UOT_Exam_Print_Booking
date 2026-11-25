"use server";
// Form wrappers for the login and logout buttons. The rules live in lib/actions/session.ts.
import { redirect } from "next/navigation";
import { login, logout } from "@/lib/actions/session";
import { homeFor } from "@/lib/auth/guard";

export type LoginFormState = { error: "invalid" } | undefined;

export async function loginAction(_prev: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const result = await login({ username: formData.get("username"), password: formData.get("password") });
  if (!result.ok) return { error: "invalid" };
  redirect(result.mustChangePassword ? "/change-password" : homeFor(result.role));
}

export async function logoutAction(): Promise<void> {
  await logout();
  redirect("/login");
}
