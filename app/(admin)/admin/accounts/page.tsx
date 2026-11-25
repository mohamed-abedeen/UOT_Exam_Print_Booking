import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/admin/page-loading";
import { listColleges } from "@/lib/actions/colleges";
import { listUsers } from "@/lib/actions/users";
import { requireRole } from "@/lib/auth/guard";
import { AccountsManager } from "./accounts-manager";

export const metadata: Metadata = { title: "الحسابات" };

async function Accounts() {
  const actor = await requireRole(["admin"]);
  const [users, colleges] = await Promise.all([listUsers(), listColleges()]);
  return <AccountsManager users={users} colleges={colleges} currentUserId={actor.userId} />;
}

export default function AccountsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Accounts />
    </Suspense>
  );
}
