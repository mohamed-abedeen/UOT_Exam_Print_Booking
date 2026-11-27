// The links each role's sidebar and tab bar show. Labels are the ones the screens already use.
import type { IconName } from "@/components/ui/icons";
import type { Role } from "@/lib/auth/session";

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** Active only on this exact path (a parent path would otherwise light up on every child page). */
  exact?: boolean;
  /** Other path prefixes that also belong to this item. */
  also?: string[];
  /** Shown as a tab on phones (4-5 tabs); the rest sit behind the "more" tab. */
  tab?: boolean;
};

export const NAV_ITEMS: Record<Role, NavItem[]> = {
  college: [
    { href: "/college", label: "حجوزاتي", icon: "calendar", exact: true, also: ["/college/edit"], tab: true },
    { href: "/college/book", label: "حجز جديد", icon: "plus", tab: true },
    { href: "/college/saturday", label: "طلبات السبت", icon: "clock", tab: true },
  ],
  operator: [
    { href: "/operator", label: "قائمة اليوم", icon: "list", exact: true, tab: true },
    { href: "/operator/sheet", label: "ورقة اليوم المطبوعة", icon: "doc", tab: true },
  ],
  admin: [
    { href: "/admin/machines", label: "الآلات", icon: "printer", tab: true },
    { href: "/admin/maintenance", label: "الصيانة", icon: "wrench", tab: true },
    { href: "/admin/reschedule", label: "إعادة الجدولة", icon: "swap" },
    { href: "/admin/stock", label: "المخزون", icon: "box" },
    { href: "/admin/book", label: "حجز لكلية", icon: "plus" },
    { href: "/admin/sheet", label: "ورقة اليوم", icon: "doc", tab: true },
    { href: "/admin/reports", label: "التقارير", icon: "chart", tab: true },
    { href: "/admin/saturday", label: "طلبات السبت", icon: "clock" },
    { href: "/admin/colleges", label: "الكليات", icon: "building" },
    { href: "/admin/accounts", label: "الحسابات", icon: "users" },
    { href: "/admin/settings", label: "الإعدادات", icon: "gear" },
    { href: "/admin/audit", label: "سجل العمليات", icon: "list" },
  ],
};

export function isActive(item: NavItem, pathname: string) {
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  if (item.exact) return pathname === item.href || (item.also ?? []).some(under);
  return under(item.href) || (item.also ?? []).some(under);
}
