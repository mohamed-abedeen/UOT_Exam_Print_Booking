import Link from "next/link";

const links = [
  { href: "/admin/machines", label: "الآلات" },
  { href: "/admin/maintenance", label: "الصيانة" },
  { href: "/admin/reschedule", label: "إعادة الجدولة" },
  { href: "/admin/stock", label: "المخزون" },
  { href: "/admin/book", label: "حجز لكلية" },
  { href: "/admin/sheet", label: "ورقة اليوم" },
  { href: "/admin/reports", label: "التقارير" },
  { href: "/admin/saturday", label: "طلبات السبت" },
  { href: "/admin/colleges", label: "الكليات" },
  { href: "/admin/accounts", label: "الحسابات" },
  { href: "/admin/settings", label: "الإعدادات" },
];

export function AdminNav() {
  return (
    <nav className="mb-4 print:hidden flex flex-wrap gap-x-4 gap-y-2 border-b border-zinc-300 pb-3 dark:border-zinc-700">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="underline-offset-4 hover:underline">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
