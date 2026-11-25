"use server";
// Account actions (contracts §4 "Colleges and accounts"): admin only. No self sign-up.
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { colleges, users } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import { requireRole } from "@/lib/auth/guard";
import { generateTempPassword, hashPassword } from "@/lib/auth/password";
import { deleteUserSessions, type Role } from "@/lib/auth/session";

const ADMIN = ["admin"] as const;

const username = z.string().trim().regex(/^[a-zA-Z0-9._-]{3,32}$/);
const fullName = z.string().trim().min(1).max(100);
const id = z.number().int().positive();

/** The name of the unique constraint a failed write hit, or null. Drizzle wraps the driver error in `cause`. */
function uniqueViolation(error: unknown): string | null {
  for (let e = error as { code?: string; constraint_name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === "23505") return e.constraint_name ?? "";
  }
  return null;
}

export interface UserRow {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  collegeId: number | null;
  collegeName: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export async function listUsers(): Promise<UserRow[]> {
  await requireRole(ADMIN);
  return getDb()
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      role: users.role,
      collegeId: users.collegeId,
      collegeName: colleges.name,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
      lockedUntil: users.lockedUntil,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(colleges, eq(colleges.id, users.collegeId))
    .orderBy(asc(users.id));
}

const createUserInput = z
  .object({
    username,
    fullName,
    role: z.enum(["college", "operator", "admin"]),
    collegeId: id.optional(),
  })
  .refine((v) => (v.role === "college") === (v.collegeId !== undefined));

export type CreateUserResult =
  | { ok: true; user: { id: number }; temporaryPassword: string }
  | { ok: false; error: "validation" | "username_taken" | "college_taken" | "college_not_found" };

/** The server makes the temporary password; it is returned once and the user must change it at first login. */
export async function createUser(input: unknown): Promise<CreateUserResult> {
  const actor = await requireRole(ADMIN);
  const parsed = createUserInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const v = parsed.data;
  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  try {
    return await getDb().transaction(async (tx): Promise<CreateUserResult> => {
      if (v.collegeId !== undefined) {
        const [college] = await tx.select({ isActive: colleges.isActive }).from(colleges).where(eq(colleges.id, v.collegeId));
        if (!college?.isActive) return { ok: false, error: "college_not_found" };
      }
      const [user] = await tx
        .insert(users)
        .values({
          username: v.username,
          passwordHash,
          role: v.role,
          collegeId: v.collegeId ?? null,
          fullName: v.fullName,
          mustChangePassword: true,
          createdBy: actor.userId,
        })
        .returning({ id: users.id });
      await audit(tx, actor, {
        action: "user.create",
        entity: "users",
        entityId: user.id,
        collegeId: v.collegeId ?? null,
        details: { username: v.username, fullName: v.fullName, role: v.role },
      });
      return { ok: true, user: { id: user.id }, temporaryPassword };
    });
  } catch (e) {
    const constraint = uniqueViolation(e);
    if (constraint === "users_username_key") return { ok: false, error: "username_taken" };
    if (constraint === "users_one_per_college") return { ok: false, error: "college_taken" };
    throw e;
  }
}

const updateUserInput = z
  .object({ userId: id, username: username.optional(), fullName: fullName.optional() })
  .refine((v) => v.username !== undefined || v.fullName !== undefined);

export type UpdateUserResult = { ok: true } | { ok: false; error: "validation" | "not_found" | "username_taken" };

/** Changes the username and / or the full name. Role and college are fixed when the account is created. */
export async function updateUser(input: unknown): Promise<UpdateUserResult> {
  const actor = await requireRole(ADMIN);
  const parsed = updateUserInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const v = parsed.data;

  try {
    return await getDb().transaction(async (tx): Promise<UpdateUserResult> => {
      const [before] = await tx.select().from(users).where(eq(users.id, v.userId)).for("update");
      if (!before) return { ok: false, error: "not_found" };
      const after = { username: v.username ?? before.username, fullName: v.fullName ?? before.fullName };
      if (after.username === before.username && after.fullName === before.fullName) return { ok: true };
      await tx.update(users).set({ ...after, updatedAt: new Date() }).where(eq(users.id, before.id));
      await audit(tx, actor, {
        action: "user.update",
        entity: "users",
        entityId: before.id,
        collegeId: before.collegeId,
        details: { before: { username: before.username, fullName: before.fullName }, after },
      });
      return { ok: true };
    });
  } catch (e) {
    if (uniqueViolation(e) === "users_username_key") return { ok: false, error: "username_taken" };
    throw e;
  }
}

const setUserActiveInput = z.object({ userId: id, isActive: z.boolean() });

export type SetUserActiveResult =
  | { ok: true }
  | { ok: false; error: "validation" | "not_found" | "self" | "college_taken" | "college_not_found" };

/** Deactivating ends the user's sessions. An admin cannot deactivate their own account, so one active admin always remains. */
export async function setUserActive(input: unknown): Promise<SetUserActiveResult> {
  const actor = await requireRole(ADMIN);
  const parsed = setUserActiveInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const v = parsed.data;
  if (v.userId === actor.userId) return { ok: false, error: "self" };

  try {
    return await getDb().transaction(async (tx): Promise<SetUserActiveResult> => {
      const [before] = await tx.select().from(users).where(eq(users.id, v.userId)).for("update");
      if (!before) return { ok: false, error: "not_found" };
      if (before.isActive === v.isActive) return { ok: true };
      if (v.isActive && before.collegeId !== null) {
        // same rule as createUser: no active account for a college that is itself inactive
        const [college] = await tx.select({ isActive: colleges.isActive }).from(colleges).where(eq(colleges.id, before.collegeId));
        if (!college?.isActive) return { ok: false, error: "college_not_found" };
      }
      await tx.update(users).set({ isActive: v.isActive, updatedAt: new Date() }).where(eq(users.id, before.id));
      if (!v.isActive) await deleteUserSessions(tx, before.id);
      await audit(tx, actor, {
        action: "user.set_active",
        entity: "users",
        entityId: before.id,
        collegeId: before.collegeId,
        details: { before: { isActive: before.isActive }, after: { isActive: v.isActive } },
      });
      return { ok: true };
    });
  } catch (e) {
    // reactivating a college account while that college already has an active one
    if (uniqueViolation(e) === "users_one_per_college") return { ok: false, error: "college_taken" };
    throw e;
  }
}

const resetUserPasswordInput = z.object({ userId: id });

export type ResetUserPasswordResult =
  | { ok: true; temporaryPassword: string }
  | { ok: false; error: "validation" | "not_found" | "self" };

/** New temporary password, shown once. Ends the user's sessions and lifts a login lock. Own password: changeOwnPassword. */
export async function resetUserPassword(input: unknown): Promise<ResetUserPasswordResult> {
  const actor = await requireRole(ADMIN);
  const parsed = resetUserPasswordInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const { userId } = parsed.data;
  if (userId === actor.userId) return { ok: false, error: "self" };
  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  return getDb().transaction(async (tx): Promise<ResetUserPasswordResult> => {
    const [target] = await tx
      .update(users)
      .set({
        passwordHash,
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ id: users.id, collegeId: users.collegeId });
    if (!target) return { ok: false, error: "not_found" };
    await deleteUserSessions(tx, target.id);
    await audit(tx, actor, {
      action: "user.reset_password",
      entity: "users",
      entityId: target.id,
      collegeId: target.collegeId,
    });
    return { ok: true, temporaryPassword };
  });
}
