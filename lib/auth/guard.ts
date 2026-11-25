// The role guard (contracts §4, rules 1–3) and the session cookie.
// Every server action and every data read starts with requireRole().
import "server-only";
import { isIP } from "node:net";
import { eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getDb } from "@/db";
import { readSession, SESSION_MAX_MS, type Role, type SessionUser } from "./session";

export const SESSION_COOKIE = "uot_session";
export const ALL_ROLES: readonly Role[] = ["college", "operator", "admin"];

export interface Actor extends SessionUser {
  ip: string | null;
}

/** A logged-in user asked for something their role (or college) may not do. */
export class AuthError extends Error {
  readonly code = "forbidden";
  constructor() {
    super("forbidden");
    this.name = "AuthError";
  }
}

export function homeFor(role: Role): string {
  return role === "admin" ? "/admin" : role === "operator" ? "/operator" : "/college";
}

/**
 * Client address and browser, for `sessions` and `audit_log`. Log data only: never used for a decision.
 * The address is the LAST entry of X-Forwarded-For — the one our own HTTPS proxy appends; earlier entries are
 * whatever the client sent. Revisit in the deployment step if there is more than one proxy.
 */
export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const last = h.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
  return { ip: isIP(last) ? last : null, userAgent: h.get("user-agent") };
}

/** Cookie flags fixed in step 1.2: HttpOnly, SameSite=Lax, Secure in production, Path=/. */
export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_MS / 1000, // the server decides when the session ends; the cookie only must not outlive it
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The current user, or null. Checks the DB on every call: a deleted session or deactivated user is out at once. */
export async function getActor(): Promise<Actor | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  await connection(); // a session is checked against a real request and the current time, never prerendered or prefetched
  const user = await readSession(getDb(), token, new Date());
  if (!user) return null;
  return { ...user, ip: (await requestMeta()).ip };
}

/**
 * Rule 1: the first line of every action.
 * - no valid session, or inactive user → redirect to /login
 * - temporary password not changed yet → redirect to /change-password (only changeOwnPassword passes allowMustChangePassword)
 * - wrong role → AuthError
 * Nothing is read before it returns.
 */
export async function requireRole(
  roles: readonly Role[],
  opts: { allowMustChangePassword?: boolean } = {},
): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.mustChangePassword && !opts.allowMustChangePassword) redirect("/change-password");
  if (!roles.includes(actor.role)) throw new AuthError();
  return actor;
}

/**
 * Rules 2–3: which college's rows this request is about.
 * college → always its own (a `collegeId` in the request is refused); admin → the one asked for, or null = all;
 * operator → null = all (it never passes a `collegeId`).
 */
export function collegeScope(actor: Actor, requestedCollegeId?: number): number | null {
  if (actor.role === "admin") return requestedCollegeId ?? null;
  if (requestedCollegeId !== undefined) throw new AuthError();
  if (actor.role === "college") {
    if (actor.collegeId === null) throw new AuthError();
    return actor.collegeId;
  }
  return null;
}

/**
 * The "own" filter for a read or write on a table with a college column: put it in the WHERE of every query a
 * college user can reach. Another college's row is then simply not found. Undefined (no filter) for other roles.
 */
export function ownRows(actor: Actor, collegeColumn: AnyPgColumn): SQL | undefined {
  const scope = collegeScope(actor);
  return scope === null ? undefined : eq(collegeColumn, scope);
}
