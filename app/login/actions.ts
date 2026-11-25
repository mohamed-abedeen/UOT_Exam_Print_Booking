"use server";
// Form wrapper for the login button. The rules live in lib/actions/session.ts. Logout is app/logout/route.ts.
import { login } from "@/lib/actions/session";
import { homeFor } from "@/lib/auth/guard";

/** `to`: signed in; the form loads that page as a new document (no redirect() here, see login-form.tsx). */
export type LoginFormState = { error: "invalid" } | { to: string } | undefined;

export async function loginAction(_prev: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const result = await login({ username: formData.get("username"), password: formData.get("password") });
  if (!result.ok) return { error: "invalid" };
  return { to: result.mustChangePassword ? "/change-password" : homeFor(result.role) };
}
