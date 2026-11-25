// Logout as a plain form post (the button in components/auth/role-shell.tsx), not a server action:
// the answer is a real redirect, so the browser loads /login as a new document and nothing of the
// previous user's pages stays in the tab (Next keeps visited routes alive, hidden, with cacheComponents).
// A cross-site post carries no session cookie (SameSite=Lax), so it signs nobody out.
import { logout } from "@/lib/actions/session";

export async function POST(): Promise<Response> {
  await logout();
  return new Response(null, { status: 303, headers: { Location: "/login" } });
}
