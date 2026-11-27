// Flow 4: the admin stops every machine → a booking is moved from machine to machine and, with none left, flagged
// for the admin's decision (the college sees it, the reschedule list shows it) → the machines are started again.
// Small jobs may also run on the bigger machines, so the flag appears only once all seven are stopped.
import { expect, test } from "@playwright/test";
import { book, card, login, tripoliDate } from "./helpers";

const MACHINES = ["آلة (1)", "آلة (2)", "آلة (3)", "آلة (4)", "آلة (5)", "آلة (6) أ", "آلة (6) ب"];

test("machine stop flags the booking; restart restores the machines", async ({ browser }) => {
  const collegeCtx = await browser.newContext();
  const college = await collegeCtx.newPage();
  await login(college, "science", /\/college$/);
  const reference = await book(college, {
    subject: "e2e إيقاف آلة",
    copies: "20",
    pages: "10",
    date: tripoliDate(1),
    hour: 14,
  });
  await expect(card(college, reference)).not.toContainText("بانتظار قرار الإدارة");

  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, "admin", /\/admin\/machines$/);
  await admin.goto("/admin/maintenance");
  const machineRow = (name: string) => admin.getByRole("row").filter({ hasText: name }).first();

  for (const name of MACHINES) {
    await machineRow(name).getByRole("button", { name: "إيقاف / صيانة" }).click();
    await admin.getByLabel("السبب").fill("e2e");
    await admin.getByRole("button", { name: "سجّل الإيقاف" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "سُجّل الإيقاف" })).toBeVisible();
    await expect(machineRow(name)).toContainText("متوقفة منذ");
  }
  // the last stop left no machine for the job
  await expect(admin.getByRole("status").filter({ hasText: "ينتظر إعادة الجدولة" })).toBeVisible();

  await admin.goto("/admin/reschedule");
  await expect(admin.getByText(reference).first()).toBeVisible();

  await college.reload();
  await expect(card(college, reference)).toContainText("بانتظار قرار الإدارة");

  await admin.goto("/admin/maintenance");
  for (const name of MACHINES) {
    await machineRow(name).getByRole("button", { name: "إعادة التشغيل" }).click();
    await expect(machineRow(name)).toContainText("تعمل");
  }

  await collegeCtx.close();
  await adminCtx.close();
});
