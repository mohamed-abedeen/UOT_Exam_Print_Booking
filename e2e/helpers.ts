import { expect, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "./env";

const TRIPOLI_OFFSET_MS = 2 * 60 * 60 * 1000; // the app's business clock is a fixed UTC+2 (lib/scheduling/time.ts)

/** The business-clock date `plusDays` from today, 'YYYY-MM-DD'. */
export function tripoliDate(plusDays = 0): string {
  return new Date(Date.now() + TRIPOLI_OFFSET_MS + plusDays * 86_400_000).toISOString().slice(0, 10);
}

/** The business-clock hour now, 0–23. */
export const tripoliHour = (): number => new Date(Date.now() + TRIPOLI_OFFSET_MS).getUTCHours();

/** Signs in through the login form and waits for the role's home page. */
export async function login(page: Page, username: string, home: RegExp): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("اسم المستخدم").fill(username);
  await page.getByLabel("كلمة المرور").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "دخول" }).click();
  await expect(page).toHaveURL(home);
}

export interface Job {
  subject: string;
  copies: string;
  pages: string;
  date: string;
  hour: number;
}

/** A college books through the form; returns the reference shown after the redirect. */
export async function book(page: Page, job: Job): Promise<string> {
  await page.goto("/college/book");
  await page.getByLabel("اسم الدكتور").fill("د. خالد المهدي");
  await page.getByLabel("رقم هاتف الدكتور").fill("0912345678");
  await page.getByLabel("اسم المستلم رباعيًا").fill("محمد أحمد علي حسن");
  await page.getByLabel("المادة").fill(job.subject);
  await page.getByLabel("عدد النسخ").fill(job.copies);
  await page.getByLabel("عدد النماذج").fill("1");
  await page.getByLabel("عدد الصفحات لكل نموذج").fill(job.pages);
  await page.getByLabel("اليوم").fill(job.date);
  await page.getByLabel("ساعة البدء").selectOption(String(job.hour));
  await expect(page.getByText("الموعد متاح")).toBeVisible(); // the live availability answer
  await page.getByRole("button", { name: "احجز", exact: true }).click();
  await expect(page).toHaveURL(/booked=/);
  const reference = new URL(page.url()).searchParams.get("booked");
  expect(reference).toBeTruthy();
  return reference!;
}

/** The college card of one booking. */
export const card = (page: Page, reference: string) => page.getByRole("listitem").filter({ hasText: reference });
