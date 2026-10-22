import { expect, test } from "@playwright/test";
import { th } from "../../src/i18n/th";

test("home screen shows the app name and build version", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(th.appName);
  await expect(page).toHaveTitle(th.appName);
  await expect(page.getByTestId("version")).toContainText(/\d+\.\d+\.\d+\+\w+/);
  expect(errors).toEqual([]);
});

test("production build carries a strict Content Security Policy", async ({ page }) => {
  await page.goto("./");
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
});

test("icons and fonts load from the app itself", async ({ page }) => {
  const outside: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith("http://localhost:4173/")) outside.push(r.url()); });
  await page.goto("./");
  await page.evaluate(() => document.fonts.ready);
  const iconOk = await page.locator("main img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  expect(iconOk).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('600 32px "Mali"', "นักวาด"))).toBe(true);
  expect(outside).toEqual([]);
});
