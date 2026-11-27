"use client";
// The college's bell (step 2.2): unread count on the button, the newest notifications in a panel. The data is read
// on the server when the page loads (owner, 2026-11-25: no polling). A click marks the row read and opens the list.
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { markNotificationRead } from "@/lib/actions/notifications";
import { dayOf, timeOf } from "@/lib/bookings/format";
import type { NotificationItem } from "@/lib/notifications";
import { notificationText } from "@/lib/notifications/text";

const TARGET = "/college";

export function NotificationBell({ unread, items }: { unread: number; items: NotificationItem[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [readHere, setReadHere] = useState<ReadonlySet<number>>(new Set());
  const [, startTransition] = useTransition();
  const box = useRef<HTMLDivElement>(null);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isUnread = (n: NotificationItem) => n.readAt === null && !readHere.has(n.id);
  // The server's count minus the rows marked read here since that count was read.
  const count = Math.max(0, unread - items.filter((n) => n.readAt === null && readHere.has(n.id)).length);

  function pick(n: NotificationItem) {
    setOpen(false);
    setReadHere((s) => new Set(s).add(n.id));
    startTransition(async () => {
      await markNotificationRead({ id: n.id });
      if (pathname !== TARGET) router.push(TARGET);
      router.refresh();
    });
  }

  return (
    // Phone: the panel spans the header's width (the header is its positioned parent). From `sm` up it hangs under the bell.
    <div ref={box} className="sm:relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={count > 0 ? `الإشعارات، غير المقروءة ${count}` : "الإشعارات"}
        className="lg relative flex size-11 items-center justify-center rounded-full"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {count > 0 && (
          <span className="absolute -top-1 -end-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold text-white dark:bg-rose-600">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="glass-panel pop-in absolute inset-x-4 top-full z-10 mt-1 rounded-2xl text-start text-sm font-normal sm:inset-x-auto sm:start-0 sm:mt-2 sm:w-80">
          {items.length === 0 ? (
            <p className="p-4 text-muted-foreground">لا توجد إشعارات.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded-2xl">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => pick(n)}
                    className="flex w-full flex-col gap-1 px-4 py-3 text-start transition-colors hover:bg-foreground/5"
                  >
                    <span className={isUnread(n) ? "font-bold" : "text-muted-foreground"}>
                      {isUnread(n) && <span aria-hidden="true" className="me-2 inline-block size-2 rounded-full bg-primary" />}
                      {notificationText(n.type, n.data)}
                    </span>
                    <span className="text-xs text-muted-foreground" dir="ltr">
                      {dayOf(n.createdAt)} {timeOf(n.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
