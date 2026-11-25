import { RoleShell } from "@/components/auth/role-shell";

export default function CollegeLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleShell role="college" title="بوابة الكلية">
      {children}
    </RoleShell>
  );
}
