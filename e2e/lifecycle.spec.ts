// Flow 1: a college books for today → the operator confirms identity → ready (with waste) → delivered → the college sees it.
import { expect, test } from "@playwright/test";
import { book, card, login, tripoliDate, tripoliHour } from "./helpers";

test("book → confirm identity → ready → delivered", async ({ browser }) => {
  // The booking must start later today, and the last start hour of the e2e day is 23.
  test.skip(tripoliHour() >= 23, "after 23:00 on the business clock nothing more can start today");

  const collegeCtx = await browser.newContext();
  const college = await collegeCtx.newPage();
  await login(college, "engineering", /\/college$/);
  const reference = await book(college, {
    subject: "e2e دورة الحياة",
    copies: "20",
    pages: "10",
    date: tripoliDate(0),
    hour: tripoliHour() + 1,
  });
  await expect(card(college, reference)).toContainText("محجوز");

  const operatorCtx = await browser.newContext();
  const operator = await operatorCtx.newPage();
  await login(operator, "operator", /\/operator$/);
  const row = operator.getByRole("row").filter({ hasText: reference });
  await expect(row).toContainText("محجوز");

  await row.getByRole("button", { name: "تأكيد الهوية" }).click();
  await expect(row).toContainText("قيد التنفيذ");

  await row.getByRole("button", { name: "جاهز", exact: true }).click();
  await row.getByLabel("الأوراق التالفة").fill("3");
  await row.getByLabel("تم إتلاف النسخ التالفة").check();
  await row.getByRole("button", { name: "تأكيد الجاهزية" }).click();
  await expect(row).toContainText("جاهز للاستلام");

  operator.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "تم التسليم" }).click();
  await expect(row).toContainText("تم التسليم");
  await expect(row.getByRole("button")).toHaveCount(0); // final: no more actions

  await college.reload();
  await expect(card(college, reference)).toContainText("تم التسليم");
  await expect(card(college, reference).getByRole("button")).toHaveCount(0);

  await collegeCtx.close();
  await operatorCtx.close();
});
