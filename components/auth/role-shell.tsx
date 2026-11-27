// The frame of each role's area: title, who is signed in, logout, and a redirect for visitors of the wrong kind.
// The redirect is for people; it protects nothing. A layout cannot stop a page from rendering, so every page's
// data read and every action calls requireRole() itself (contracts §4, rule 1).
import "server-only";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SideNav, TabBar } from "@/components/auth/role-nav";
import { ThemeButton } from "@/components/auth/theme-button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { Icon } from "@/components/ui/icons";
import { listMyNotifications } from "@/lib/actions/notifications";
import { getActor, homeFor } from "@/lib/auth/guard";
import type { Role } from "@/lib/auth/session";

async function RoleGate({ role, children }: { role: Role; children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.mustChangePassword) redirect("/change-password");
  if (actor.role !== role) redirect(homeFor(actor.role));
  return children;
}

async function UserMenu() {
  const actor = await getActor();
  if (!actor) return null;
  return (
    // A plain post to app/logout/route.ts: logout ends with a full page load (see that file).
    <form method="post" action="/logout" className="flex items-center gap-3 text-sm font-normal">
      <span className="hidden sm:inline">{actor.fullName}</span>
      <button
        type="submit"
        aria-label="تسجيل الخروج"
        className="glass-soft flex size-11 items-center justify-center font-semibold sm:w-auto sm:gap-2 sm:px-4"
      >
        <Icon name="logout" variant="line" className="size-5 -scale-x-100 sm:size-[18px]" />
        <span className="hidden sm:inline">تسجيل الخروج</span>
      </button>
    </form>
  );
}

// The college's bell (step 2.2). Read on the server with the page; other roles have none.
async function Bell() {
  const actor = await getActor();
  if (!actor || actor.mustChangePassword || actor.role !== "college") return null;
  const { unread, items } = await listMyNotifications();
  return <NotificationBell unread={unread} items={items} />;
}

export function RoleShell({ role, title, children }: { role: Role; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col lg:ps-72 print:ps-0">
      <Suspense fallback={null}>
        <SideNav role={role} />
      </Suspense>
      <header className="print:hidden sticky top-0 z-40 isolate flex h-[calc(76px+env(safe-area-inset-top))] items-center gap-2 px-4 pt-[env(safe-area-inset-top)] lg:h-16">
        <div aria-hidden="true" className="header-glass pointer-events-none absolute inset-0 -z-10 border-b border-border" />
        <div className="flex flex-1 items-center justify-start gap-2">
          <ThemeButton />
          {role === "college" && (
            <Suspense fallback={null}>
              <Bell />
            </Suspense>
          )}
        </div>
        <span className="flex items-center gap-2 text-[15px] font-bold">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground lg:hidden">
            <Icon name="printer" className="size-[18px]" />
          </span>
          {title}
        </span>
        <div className="flex flex-1 items-center justify-end gap-3">
          <Suspense fallback={null}>
            <UserMenu />
          </Suspense>
        </div>
      </header>
      <main className="flex-1 p-4 pb-24 lg:p-6 print:p-0">
        <Suspense fallback={null}>
          <RoleGate role={role}>{children}</RoleGate>
        </Suspense>
      </main>
      <Suspense fallback={null}>
        <TabBar role={role} />
      </Suspense>
    </div>
  );
}
