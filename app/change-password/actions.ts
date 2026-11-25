"use server";
// Form wrapper for the change-password screen. The rules live in lib/actions/session.ts.
import { redirect } from "next/navigation";
import { changeOwnPassword } from "@/lib/actions/session";
import { ALL_ROLES, homeFor, requireRole } from "@/lib/auth/guard";

export type ChangePasswordFormState =
  | { error: "validation" | "wrong_password" | "same_password" | "locked" | "mismatch" }
  | undefined;

export async function changePasswordAction(
  _prev: ChangePasswordFormState,
  formData: FormData,
): Promise<ChangePasswordFormState> {
  const newPassword = formData.get("newPassword");
  if (newPassword !== formData.get("confirmPassword")) return { error: "mismatch" };
  const result = await changeOwnPassword({ currentPassword: formData.get("currentPassword"), newPassword });
  if (!result.ok) return { error: result.error };
  const actor = await requireRole(ALL_ROLES);
  redirect(homeFor(actor.role));
}
