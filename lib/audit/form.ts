// Step 4.3 — the audit log screen: the row limit, the default range and the Arabic label of each action (contracts
// §6, §8.39). Pure (no database, no `server-only`): the page, the action and a test all use it.
import type { AuditAction } from "@/lib/auth/audit";
import { addDays } from "@/lib/scheduling/time";

/** Rows returned by one `listAuditLog` call, newest first (owner, 2026-11-27, step 4.3). */
export const AUDIT_LIMIT = 500;

/** The last 7 days: `today − 6` up to `today` (owner, 2026-11-27, step 4.3). */
export function defaultAuditRange(today: string): { from: string; to: string } {
  return { from: addDays(today, -6), to: today };
}

/** One label per audited action. Typed on `AuditAction`, so a new action cannot be added without a label. */
export const ACTION_LABEL: Record<AuditAction, string> = {
  "auth.login_failed": "فشل تسجيل الدخول",
  "auth.lockout": "قفل الحساب مؤقتاً",
  "user.create": "إنشاء حساب",
  "user.update": "تعديل حساب",
  "user.set_active": "تفعيل أو إيقاف حساب",
  "user.reset_password": "إعادة تعيين كلمة المرور",
  "college.create": "إضافة كلية",
  "college.update": "تعديل كلية",
  "college.set_active": "تفعيل أو إيقاف كلية",
  "machine.create": "إضافة آلة",
  "machine.update": "تعديل آلة",
  "machine.archive": "أرشفة آلة",
  "machine.unarchive": "إلغاء أرشفة آلة",
  "maintenance.start": "بدء صيانة",
  "maintenance.end": "انتهاء صيانة",
  "settings.update": "تعديل الإعدادات",
  "holiday.add": "إضافة عطلة",
  "holiday.remove": "حذف عطلة",
  "booking.create_on_behalf": "حجز نيابة عن كلية",
  "booking.admin_edit": "تعديل حجز (مسؤول)",
  "booking.admin_cancel": "إلغاء حجز (مسؤول)",
  "booking.move": "نقل حجز",
  "booking.auto_move": "نقل حجز تلقائي",
  "booking.flag_reschedule": "حجز يحتاج إعادة جدولة",
  "booking.delay_notice": "إشعار تأخير",
  "booking.confirm_identity": "تأكيد هوية صاحب الحجز",
  "booking.no_show": "تسجيل غياب",
  "saturday.decide": "قرار طلب سبت",
  "stock.receive": "استلام مخزون",
  "stock.consume": "صرف مخزون",
  "stock.adjust": "تسوية مخزون",
  "part.add": "إضافة قطعة غيار",
  "part.replace": "استبدال قطعة غيار",
};

/** Every audited action, as the array a validator needs. */
export const AUDIT_ACTIONS = Object.keys(ACTION_LABEL) as [AuditAction, ...AuditAction[]];

/** The label of a stored action; a code this build does not know is shown as it is. */
export function actionLabel(action: string): string {
  return (ACTION_LABEL as Record<string, string>)[action] ?? action;
}

export const AUDIT_ROLE_LABEL = { college: "كلية", operator: "مشغّل", admin: "مسؤول" } as const;
