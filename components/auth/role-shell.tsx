// The frame of each role's area: title, who is signed in, logout, and a redirect for visitors of the wrong kind.
// The redirect is for people; it protects nothing. A layout cannot stop a page from rendering, so every page's
// data read and every action calls requireRole() itself (contracts §4, rule 1).
import "server-only";
import { redirect } from "next/navigation";
import { Suspense } from "react";
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
      <span>{actor.fullName}</span>
      <button
        type="submit"
        className="rounded-lg border border-zinc-300 px-3 py-1 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        تسجيل الخروج
      </button>
    </form>
  );
}

export function RoleShell({ role, title, children }: { role: Role; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-zinc-300 px-4 py-3 font-bold dark:border-zinc-700">
        <span>{title}</span>
        <Suspense fallback={null}>
          <UserMenu />
        </Suspense>
      </header>
      <main className="flex-1 p-4">
        <Suspense fallback={null}>
          <RoleGate role={role}>{children}</RoleGate>
        </Suspense>
      </main>
    </div>
  );
}
