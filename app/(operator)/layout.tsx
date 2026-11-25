import { RoleShell } from "@/components/auth/role-shell";

export default function OperatorLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleShell role="operator" title="بوابة المشغّل">
      {children}
    </RoleShell>
  );
}
