// Flow 3: the college's one delay notice moves the booking later the same day; a second one is not offered.
import { expect, test } from "@playwright/test";
import { book, card, login, tripoliDate } from "./helpers";

test("delay notice moves the booking later the same day, once", async ({ page }) => {
  await login(page, "engineering", /\/college$/);
  const reference = await book(page, {
    subject: "e2e تأخير",
    copies: "20",
    pages: "10",
    date: tripoliDate(1),
    hour: 12,
  });
  const mine = card(page, reference);
  const before = await mine.getByText(/من \d\d:\d\d إلى/).innerText();

  await mine.getByRole("button", { name: "إشعار تأخير" }).click();
  await mine.getByRole("button", { name: "أرسل إشعار التأخير" }).click();
  await expect(mine.getByRole("status")).toContainText("تم تأخير الموعد إلى");

  await page.reload();
  await expect(mine).toContainText("أُرسل إشعار تأخير");
  expect(await mine.getByText(/من \d\d:\d\d إلى/).innerText()).not.toBe(before);
  await expect(mine.getByRole("button", { name: "إشعار تأخير" })).toHaveCount(0); // one notice per booking
});
