// Flow 2: a college cancels a booking before the deadline; the slot is free again.
import { expect, test } from "@playwright/test";
import { book, card, login, tripoliDate } from "./helpers";

test("cancel a booking and book the same slot again", async ({ page }) => {
  await login(page, "science", /\/college$/);
  const job = { subject: "e2e إلغاء", copies: "20", pages: "10", date: tripoliDate(1), hour: 10 };
  const reference = await book(page, job);

  await card(page, reference).getByRole("button", { name: "إلغاء الحجز" }).click();
  await page.getByLabel("سبب الإلغاء").fill("e2e");
  await page.getByRole("button", { name: "تأكيد الإلغاء" }).click();
  await expect(card(page, reference)).toContainText("ملغى");
  await expect(card(page, reference).getByRole("button")).toHaveCount(0);

  // the interval was released: the same slot is offered exactly and can be booked again
  const again = await book(page, job);
  expect(again).not.toBe(reference);
  await expect(card(page, again)).toContainText("محجوز");
});
