"use client";
// Navigation of a role's area: the sidebar (desktop, from 1024px) and the floating tab bar (phones). Both read the
// same list (nav-items.ts). The admin has 12 pages, so its tab bar keeps the 4 main ones and a "more" tab opens a
// bottom sheet with all of them.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icons";
import type { Role } from "@/lib/auth/session";
import { isActive, NAV_ITEMS } from "./nav-items";

export function SideNav({ role }: { role: Role }) {
  const pathname = usePathname();
  return (
    <aside className="print:hidden fixed inset-y-0 start-0 z-50 hidden w-72 flex-col gap-4 border-e border-border bg-card p-4 lg:flex">
      <div className="flex h-12 items-center gap-3 px-2">
        <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Icon name="printer" className="size-5" />
        </span>
        <span className="text-[15px] font-bold">حجز طباعة الامتحانات</span>
      </div>
      <nav aria-label="التنقل الرئيسي" className="flex flex-col gap-1 overflow-y-auto">
        {NAV_ITEMS[role].map((item) => {
          const active = isActive(item, pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex h-10 items-center gap-3 rounded-full px-4 text-[14px] transition-colors ${
                active ? "bg-foreground/10 font-semibold text-primary" : "text-foreground/70 hover:bg-foreground/5"
              }`}
            >
              <Icon name={item.icon} variant="line" strokeWidth={active ? 2.2 : 1.8} className="size-[18px] shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

const GAP = 2; // px, the bar's gap-0.5

export function TabBar({ role }: { role: Role }) {
  const pathname = usePathname();
  const all = NAV_ITEMS[role];
  const tabs = all.filter((i) => i.tab);
  const hasMore = all.length > tabs.length;
  const count = tabs.length + (hasMore ? 1 : 0);

  // The sheet belongs to the page it was opened on, so it closes by itself when the path changes.
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const sheet = sheetFor === pathname;
  const setSheet = (open: boolean) => setSheetFor(open ? pathname : null);
  const [compact, setCompact] = useState(false);

  const current = tabs.findIndex((i) => isActive(i, pathname));
  const onMore = hasMore && current === -1; // a page that is not one of the tabs lights the "more" tab
  const lit = onMore ? tabs.length : current;

  // Compact on scroll down, back on scroll up.
  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (y > last + 8 && y > 40) setCompact(true);
      else if (y < last - 8 || y <= 40) setCompact(false);
      last = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The sheet closes on Escape.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheetFor(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet]);

  const tabClass = "relative flex flex-1 flex-col items-center justify-center rounded-full text-[11px] font-semibold";
  const inner = (name: (typeof all)[number]["icon"], label: string) => (
    <>
      <Icon
        name={name}
        className="size-6 transition-[width,height] duration-[250ms] ease-[var(--ease-out)] group-data-[compact=true]:size-[22px]"
      />
      <span className="max-h-4 leading-4 transition-[max-height,opacity] duration-[250ms] ease-[var(--ease-out)] group-data-[compact=true]:max-h-0 group-data-[compact=true]:opacity-0">
        {label}
      </span>
    </>
  );

  return (
    <>
      <div className="print:hidden pointer-events-none fixed inset-x-[22px] bottom-[max(0.5rem,calc(env(safe-area-inset-bottom)-1.25rem))] z-30 flex justify-center lg:hidden">
        <nav
          aria-label="التنقل السريع"
          data-compact={compact}
          className="lg lg-seg group pointer-events-auto relative mx-auto flex h-[62px] w-full max-w-xl gap-0.5 rounded-full p-1 transition-[width,height] duration-[250ms] ease-[var(--ease-out)] data-[compact=true]:h-[50px] data-[compact=true]:w-[85%]"
        >
          {lit >= 0 && (
            <span
              aria-hidden="true"
              className="lg-seg-pill absolute inset-y-1 start-1 rounded-full transition-transform duration-[250ms] ease-[var(--ease-out)]"
              style={{
                width: `calc((100% - 0.5rem - ${(count - 1) * GAP}px) / ${count})`,
                // RTL: the pill starts at the right edge and moves left, one tab at a time
                transform: `translateX(calc(${-lit} * (100% + ${GAP}px)))`,
              }}
            />
          )}
          {tabs.map((item, i) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={i === current ? "page" : undefined}
              data-lit={i === lit ? "" : undefined}
              className={`${tabClass} ${i === lit ? "" : "text-foreground"}`}
            >
              {inner(item.icon, item.label)}
            </Link>
          ))}
          {hasMore && (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={sheet}
              data-lit={onMore ? "" : undefined}
              onClick={() => setSheet(true)}
              className={`${tabClass} ${onMore ? "" : "text-foreground"}`}
            >
              {inner("more", "المزيد")}
            </button>
          )}
        </nav>
      </div>

      {sheet && (
        <div className="print:hidden fixed inset-0 z-50 flex items-end lg:hidden">
          <button
            type="button"
            aria-label="إغلاق"
            tabIndex={-1}
            onClick={() => setSheet(false)}
            className="absolute inset-0 cursor-default bg-black/30"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="المزيد"
            className="glass-panel pop-in relative max-h-[75dvh] w-full overflow-y-auto rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]"
            style={{ transformOrigin: "bottom center" }}
          >
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <h2 className="text-[15px] font-bold">المزيد</h2>
              <button
                type="button"
                aria-label="إغلاق"
                onClick={() => setSheet(false)}
                className="lg flex size-11 items-center justify-center rounded-full"
              >
                <Icon name="close" className="size-5" />
              </button>
            </div>
            <nav aria-label="كل الصفحات" className="grid grid-cols-2 gap-2 px-4 pb-2">
              {all.map((item) => {
                const active = isActive(item, pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex h-11 items-center gap-3 rounded-full px-4 text-[14px] ${
                      active ? "bg-foreground/10 font-semibold text-primary" : "text-foreground/80 hover:bg-foreground/5"
                    }`}
                  >
                    <Icon name={item.icon} variant="line" strokeWidth={active ? 2.2 : 1.8} className="size-[18px] shrink-0" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
