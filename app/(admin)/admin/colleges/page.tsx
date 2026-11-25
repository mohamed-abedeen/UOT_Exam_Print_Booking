import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/admin/page-loading";
import { listColleges } from "@/lib/actions/colleges";
import { CollegesManager } from "./colleges-manager";

export const metadata: Metadata = { title: "الكليات" };

async function Colleges() {
  return <CollegesManager colleges={await listColleges()} />;
}

export default function CollegesPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Colleges />
    </Suspense>
  );
}
