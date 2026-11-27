import { RoleShell } from "@/components/auth/role-shell";

// The admin's links live in the shell's sidebar and tab bar (components/auth/nav-items.ts).
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleShell role="admin" title="لوحة الإدارة">
      {children}
    </RoleShell>
  );
}
