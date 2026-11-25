// audit() — contracts §6. Call it inside the same transaction as the change it records.
import type { Executor } from "@/db";
import { auditLog } from "@/db/schema";
import type { Role } from "./session";

export type AuditAction =
  | "auth.login_failed" | "auth.lockout"
  | "user.create" | "user.update" | "user.set_active" | "user.reset_password"
  | "college.create" | "college.update" | "college.set_active"
  | "machine.create" | "machine.update" | "machine.archive" | "machine.unarchive"
  | "maintenance.start" | "maintenance.end"
  | "settings.update" | "holiday.add" | "holiday.remove"
  | "booking.create_on_behalf" | "booking.admin_edit" | "booking.admin_cancel" | "booking.move"
  | "booking.auto_move" | "booking.flag_reschedule" | "booking.delay_notice" | "booking.confirm_identity"
  | "booking.no_show"
  | "saturday.decide"
  | "stock.receive" | "stock.consume" | "stock.adjust"
  | "part.add" | "part.replace";

export interface AuditEntry {
  action: AuditAction;
  /** Table name. */
  entity: string;
  entityId?: number | string | null;
  collegeId?: number | null;
  /** Before / after values. Never a password, a hash or a token. */
  details?: Record<string, unknown>;
}

/** `who` = null means the system. */
export async function audit(
  tx: Executor,
  who: { userId: number; role: Role; ip?: string | null } | null,
  entry: AuditEntry,
): Promise<void> {
  await tx.insert(auditLog).values({
    userId: who?.userId ?? null,
    role: who?.role ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId == null ? null : String(entry.entityId),
    collegeId: entry.collegeId ?? null,
    details: entry.details ?? {},
    ip: who?.ip ?? null,
  });
}
