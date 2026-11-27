// Audit log viewer (contracts §4 "Reports and audit", §8.39). Admin only; the server action in lib/actions/audit.ts runs
// the role guard and calls this. Read-only: nothing is written, no lock is taken. Not a "use server" file.
import "server-only";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, colleges, users } from "@/db/schema";
import { AuthError, type Actor } from "@/lib/auth/guard";
import type { Role } from "@/lib/auth/session";
import { dateString, VALIDATION } from "@/lib/bookings/create";
import { addDays, atMinutes } from "@/lib/scheduling/time";
import { AUDIT_ACTIONS, AUDIT_LIMIT } from "./form";

const filterInput = z
  .strictObject({
    userId: z.number().int().positive().optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    from: dateString.optional(),
    to: dateString.optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to);

export interface AuditRow {
  id: number;
  at: Date;
  userId: number | null; // null = the system
  userName: string | null;
  username: string | null;
  role: Role | null;
  action: string;
  entity: string;
  entityId: string | null;
  collegeId: number | null;
  collegeName: string | null;
  details: Record<string, unknown>;
  ip: string | null;
}
export type ListAuditLogResult = { ok: true; rows: AuditRow[]; truncated: boolean } | { ok: false; error: "validation" };

/**
 * Newest first, at most `AUDIT_LIMIT` rows; `truncated` says older rows matched too (owner, 2026-11-27, step 4.3).
 * Every filter is optional: `userId`, `action`, and `from` / `to` business dates, both inclusive, on `audit_log.at`.
 */
export async function listAuditLogFor(actor: Actor, filter: unknown = {}): Promise<ListAuditLogResult> {
  if (actor.role !== "admin") throw new AuthError();
  const parsed = filterInput.safeParse(filter ?? {});
  if (!parsed.success) return VALIDATION;
  const { userId, action, from, to } = parsed.data;
  const found = await getDb()
    .select({
      id: auditLog.id,
      at: auditLog.at,
      userId: auditLog.userId,
      userName: users.fullName,
      username: users.username,
      role: auditLog.role,
      action: auditLog.action,
      entity: auditLog.entity,
      entityId: auditLog.entityId,
      collegeId: auditLog.collegeId,
      collegeName: colleges.name,
      details: auditLog.details,
      ip: auditLog.ip,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .leftJoin(colleges, eq(colleges.id, auditLog.collegeId))
    .where(
      and(
        userId ? eq(auditLog.userId, userId) : undefined,
        action ? eq(auditLog.action, action) : undefined,
        from ? gte(auditLog.at, atMinutes(from, 0)) : undefined,
        to ? lt(auditLog.at, atMinutes(addDays(to, 1), 0)) : undefined,
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(AUDIT_LIMIT + 1);
  const rows = found.slice(0, AUDIT_LIMIT).map((r) => ({ ...r, details: (r.details ?? {}) as Record<string, unknown> }));
  return { ok: true, rows, truncated: found.length > AUDIT_LIMIT };
}
