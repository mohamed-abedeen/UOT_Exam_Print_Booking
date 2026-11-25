// DB sessions (contracts §1.3). No Next.js here: the cookie lives in guard.ts.
// Lifetime (owner, 2026-11-25): ends after 8 hours without activity, and at most 7 days after login.
// Every time is taken from the app clock (`now`), never the DB default, so the rules are testable.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lte, ne } from "drizzle-orm";
import type { Executor } from "@/db";
import { sessions, users } from "@/db/schema";

export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** `last_seen_at` / `expires_at` are rewritten at most once a minute per session. */
const TOUCH_EVERY_MS = 60 * 1000;

export type Role = (typeof users.role.enumValues)[number];

export interface SessionUser {
  sessionId: string;
  userId: number;
  role: Role;
  /** Set only for role 'college'. */
  collegeId: number | null;
  username: string;
  fullName: string;
  mustChangePassword: boolean;
}

/** The stored id: sha-256 hex of the cookie token. The raw token is never stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  ex: Executor,
  userId: number,
  meta: { ip: string | null; userAgent: string | null },
  now: Date,
): Promise<{ token: string; sessionId: string }> {
  const token = randomBytes(32).toString("base64url");
  const sessionId = hashToken(token);
  await ex.insert(sessions).values({
    id: sessionId,
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_IDLE_MS),
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
  });
  return { token, sessionId };
}

/** The session's user, or null when the token is unknown, idle-expired, older than 7 days, or the user is inactive. */
export async function readSession(ex: Executor, token: string, now: Date): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const sessionId = hashToken(token);
  const [row] = await ex
    .select({
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      role: users.role,
      collegeId: users.collegeId,
      username: users.username,
      fullName: users.fullName,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, sessionId),
        gt(sessions.expiresAt, now),
        gt(sessions.createdAt, new Date(now.getTime() - SESSION_MAX_MS)),
        eq(users.isActive, true),
      ),
    );
  if (!row) return null;

  if (now.getTime() - row.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
    const hardEnd = row.createdAt.getTime() + SESSION_MAX_MS;
    await ex
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(Math.min(now.getTime() + SESSION_IDLE_MS, hardEnd)) })
      .where(eq(sessions.id, sessionId));
  }

  return {
    sessionId,
    userId: row.userId,
    role: row.role,
    collegeId: row.collegeId,
    username: row.username,
    fullName: row.fullName,
    mustChangePassword: row.mustChangePassword,
  };
}

export async function deleteSession(ex: Executor, sessionId: string): Promise<void> {
  await ex.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Deactivating a user or changing / resetting a password ends that user's sessions (contracts §1.3). */
export async function deleteUserSessions(ex: Executor, userId: number, exceptSessionId?: string): Promise<void> {
  await ex
    .delete(sessions)
    .where(
      exceptSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
        : eq(sessions.userId, userId),
    );
}

export async function deleteExpiredSessions(ex: Executor, now: Date): Promise<void> {
  await ex.delete(sessions).where(lte(sessions.expiresAt, now));
}
