import { AdminNav } from "@/components/admin/admin-nav";
import { RoleShell } from "@/components/auth/role-shell";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleShell role="admin" title="لوحة الإدارة">
      <AdminNav />
      {children}
    </RoleShell>
  );
}
