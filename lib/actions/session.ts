"use server";
// Session actions (contracts §4 "Session"): login, logout, changeOwnPassword.
// Every argument of an exported function here comes from the browser: nothing but the form values is accepted.
import { eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { z } from "zod";
import { getDb, type Tx } from "@/db";
import { users } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import {
  ALL_ROLES,
  clearSessionCookie,
  requestMeta,
  requireRole,
  SESSION_COOKIE,
  setSessionCookie,
} from "@/lib/auth/guard";
import { burnVerify, hashPassword, isAcceptablePassword, PASSWORD_MAX, verifyPassword } from "@/lib/auth/password";
import {
  createSession,
  deleteExpiredSessions,
  deleteSession,
  deleteUserSessions,
  hashToken,
  type Role,
} from "@/lib/auth/session";

// Rate limit (owner, 2026-11-25): 5 wrong passwords in a row lock the account for 15 minutes.
// A correct password, or a lock that has run out, starts the count again.
// It counts every place a password is checked: login and the current password in changeOwnPassword.
const MAX_WRONG_PASSWORDS = 5;
const LOCK_MS = 15 * 60 * 1000;

type UserRow = typeof users.$inferSelect;

const isLocked = (user: Pick<UserRow, "lockedUntil">, now: Date) => user.lockedUntil !== null && user.lockedUntil > now;

/**
 * Counts one wrong password. `user` must be the row read FOR UPDATE in `tx`, and not locked.
 * Returns the end of the lock when this was the 5th, else null.
 */
async function countWrongPassword(
  tx: Tx,
  user: UserRow,
  now: Date,
  ip: string | null,
  via: "login" | "change_password",
): Promise<Date | null> {
  const failedCount = (user.lockedUntil === null ? user.failedLoginCount : 0) + 1;
  const lockedUntil = failedCount >= MAX_WRONG_PASSWORDS ? new Date(now.getTime() + LOCK_MS) : null;
  await tx.update(users).set({ failedLoginCount: failedCount, lockedUntil }).where(eq(users.id, user.id));
  const who = { userId: user.id, role: user.role, ip };
  const target = { entity: "users", entityId: user.id, collegeId: user.collegeId };
  await audit(tx, who, { action: "auth.login_failed", ...target, details: { failedCount, via } });
  if (lockedUntil) {
    await audit(tx, who, { action: "auth.lockout", ...target, details: { lockedUntil: lockedUntil.toISOString(), via } });
  }
  return lockedUntil;
}

const loginInput = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX),
});

/** One answer for unknown user, wrong password, locked and inactive: the caller learns nothing about the account. */
export type LoginResult = { ok: true; role: Role; mustChangePassword: boolean } | { ok: false; error: "invalid" };

export async function login(input: unknown): Promise<LoginResult> {
  const invalid: LoginResult = { ok: false, error: "invalid" };
  const parsed = loginInput.safeParse(input);
  if (!parsed.success) return invalid;
  const { username, password } = parsed.data;
  const now = new Date();
  const meta = await requestMeta();
  const oldToken = (await cookies()).get(SESSION_COOKIE)?.value;
  const db = getDb();

  // 1. Check the password outside any transaction, so slow hashing never holds a DB connection or a row lock.
  const [seen] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, lockedUntil: users.lockedUntil })
    .from(users)
    .where(sql`lower(${users.username}) = ${username.toLowerCase()}`);
  if (!seen || isLocked(seen, now)) {
    await burnVerify(password); // same cost as a real check; nothing counted or logged
    return invalid;
  }
  const passwordOk = await verifyPassword(seen.passwordHash, password);

  // 2. Decide under a row lock: parallel guesses are counted one by one, and once the account locks,
  //    every guess still in flight is refused — even a correct one.
  const session = await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, seen.id)).for("update");
    if (!user || isLocked(user, now)) return null;

    if (!passwordOk || user.passwordHash !== seen.passwordHash) {
      await countWrongPassword(tx, user, now, meta.ip, "login");
      return null;
    }
    if (!user.isActive) {
      await audit(
        tx,
        { userId: user.id, role: user.role, ip: meta.ip },
        { action: "auth.login_failed", entity: "users", entityId: user.id, collegeId: user.collegeId, details: { reason: "inactive" } },
      );
      return null;
    }

    await tx
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now })
      .where(eq(users.id, user.id));
    await deleteExpiredSessions(tx, now);
    // The session this browser held until now (any user's) ends with the cookie that is about to be replaced.
    if (oldToken && oldToken.length <= 200) await deleteSession(tx, hashToken(oldToken)); // same cap as readSession
    const { token } = await createSession(tx, user.id, meta, now);
    return { token, role: user.role, mustChangePassword: user.mustChangePassword };
  });

  if (!session) return invalid;
  await setSessionCookie(session.token);
  return { ok: true, role: session.role, mustChangePassword: session.mustChangePassword };
}

export async function logout(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(getDb(), hashToken(token));
  await clearSessionCookie();
}

const changePasswordInput = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword: z.string(),
});

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; error: "validation" | "wrong_password" | "same_password" | "locked" };

/**
 * Any role. The only action open while `must_change_password` is set. Ends the user's other sessions.
 * A wrong current password counts toward the lock like a wrong login; the 5th also ends every session of the
 * user, this one included — a stolen or unattended session cannot be used to guess the password.
 */
export async function changeOwnPassword(input: unknown): Promise<ChangePasswordResult> {
  const actor = await requireRole(ALL_ROLES, { allowMustChangePassword: true });
  const parsed = changePasswordInput.safeParse(input);
  if (!parsed.success || !isAcceptablePassword(parsed.data.newPassword)) return { ok: false, error: "validation" };
  const { currentPassword, newPassword } = parsed.data;
  const now = new Date();
  const db = getDb();

  const [seen] = await db
    .select({ passwordHash: users.passwordHash, lockedUntil: users.lockedUntil })
    .from(users)
    .where(eq(users.id, actor.userId));
  if (!seen || isLocked(seen, now)) return { ok: false, error: "locked" };
  const passwordOk = await verifyPassword(seen.passwordHash, currentPassword);
  if (passwordOk && newPassword === currentPassword) return { ok: false, error: "same_password" };
  const passwordHash = passwordOk ? await hashPassword(newPassword) : null;

  const result = await db.transaction(async (tx): Promise<ChangePasswordResult & { signedOut?: true }> => {
    const [user] = await tx.select().from(users).where(eq(users.id, actor.userId)).for("update");
    if (!user || isLocked(user, now)) return { ok: false, error: "locked" };

    // also wrong when the password changed since it was checked (an admin reset in between wins)
    if (passwordHash === null || user.passwordHash !== seen.passwordHash) {
      const lockedUntil = await countWrongPassword(tx, user, now, actor.ip, "change_password");
      if (!lockedUntil) return { ok: false, error: "wrong_password" };
      await deleteUserSessions(tx, user.id);
      return { ok: false, error: "locked", signedOut: true };
    }

    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(eq(users.id, user.id));
    await deleteUserSessions(tx, user.id, actor.sessionId);
    return { ok: true };
  });

  if (result.ok) return { ok: true };
  if (result.signedOut) await clearSessionCookie();
  return { ok: false, error: result.error };
}
