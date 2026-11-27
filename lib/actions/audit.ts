"use server";
// Audit log action (contracts §4 "Reports and audit"). Every export of this file is a public endpoint: the role guard
// is the first line; the work is in lib/audit/. Admin only.
import { listAuditLogFor, type ListAuditLogResult } from "@/lib/audit";
import { requireRole } from "@/lib/auth/guard";

/** Admin only: audit rows, newest first, filtered by user, action and business dates (all optional). */
export async function listAuditLog(filter?: unknown): Promise<ListAuditLogResult> {
  const actor = await requireRole(["admin"]);
  return listAuditLogFor(actor, filter);
}
