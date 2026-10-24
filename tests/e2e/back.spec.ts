import { expect, test, type Page } from "@playwright/test";

// The Android back button (a step back in the browser history): closes the top window or menu,
// then the work (saved, back to the gallery); in the gallery it leaves the app.

async function start(page: Page) {
  await page.goto("about:blank");
  await page.goto("./");
  await expect(page.locator('[data-action="new-work"]')).toBeVisible();
}
async function newWork(page: Page) {
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
}
const back = (page: Page) => page.evaluate(() => history.back());
const inApp = (page: Page) => page.url().includes("/nakwad/");

test("back closes a window, then a menu, then the work; once more leaves the app", async ({ page }) => {
  await start(page);
  await newWork(page);
  await page.locator('[data-action="settings"]').click();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await back(page);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByTestId("paper")).toBeVisible();

  await page.getByTestId("toolbar").locator('[data-action="brush"]').click();
  await expect(page.getByTestId("brush-menu")).toBeVisible();
  await back(page);
  await expect(page.getByTestId("brush-menu")).toHaveCount(0);
  await expect(page.getByTestId("paper")).toBeVisible();

  await page.keyboard.press("t"); // the text tool: back leaves it first
  await expect(page.getByTestId("toolbar").locator('[data-action="text"]')).toHaveAttribute("aria-pressed", "true");
  await back(page);
  await expect(page.getByTestId("toolbar").locator('[data-action="text"]')).toHaveAttribute("aria-pressed", "false");

  await back(page);
  await expect(page.locator('.gcard[data-work]')).toHaveCount(1);
  expect(inApp(page)).toBe(true);
  await back(page);
  await expect.poll(() => inApp(page)).toBe(false);
});

test("in the gallery, back closes the new-work window first", async ({ page }) => {
  await start(page);
  await page.locator('[data-action="new-work"]').click();
  await expect(page.locator("#new-work")).toBeVisible();
  await back(page);
  await expect(page.locator("#new-work")).toHaveCount(0);
  expect(inApp(page)).toBe(true);
  await back(page);
  await expect.poll(() => inApp(page)).toBe(false);
});

test("leaving the work with its own button leaves no extra step: back then leaves the app", async ({ page }) => {
  await start(page);
  await newWork(page);
  await page.locator('[data-action="gallery"]').click();
  await expect(page.locator('.gcard[data-work]')).toHaveCount(1);
  await back(page);
  await expect.poll(() => inApp(page)).toBe(false);
});
