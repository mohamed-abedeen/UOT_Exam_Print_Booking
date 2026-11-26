import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/admin/page-loading";
import { getSettings, listHolidays } from "@/lib/actions/settings";
import { localDate } from "@/lib/scheduling/time";
import { SettingsManager } from "./settings-manager";

export const metadata: Metadata = { title: "الإعدادات" };

async function Settings() {
  const [settings, holidays] = await Promise.all([getSettings(), listHolidays()]);
  // The clock is read after the session and the database were: this page is dynamic anyway.
  return <SettingsManager settings={settings.settings} holidays={holidays.items} today={localDate(new Date())} />;
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Settings />
    </Suspense>
  );
}
