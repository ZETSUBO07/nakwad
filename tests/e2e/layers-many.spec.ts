import { expect, test, type Page } from "@playwright/test";
import { th } from "../../src/i18n/th";

// Choosing several layers: tick boxes, then hide, lock, merge or delete them together (one undo step).

const name = (n: number) => th.layerDefaultName.replace("{n}", String(n));
const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((acc, [k, x]) => acc.replace(`{${k}}`, String(x)), s);

async function newWork(page: Page) {
  await page.goto("./");
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
  await expect(page.getByTestId("layers")).toBeVisible();
  await page.getByTestId("toolbar").locator('[data-field="size"]').fill("24");
}

const names = (page: Page) => page.locator(".lrow .lname b").allTextContents();
const row = (page: Page, n: number) => page.locator(".lrow", { has: page.locator(".lname b", { hasText: new RegExp(`^${name(n)}$`) }) });
const bulk = (page: Page) => page.getByTestId("layer-bulk");
const bulkBtn = (page: Page, k: string) => bulk(page).locator(`[data-action="bulk-${k}"]`);
const undoBtn = (page: Page) => page.getByTestId("toolbar").locator('[data-action="undo"]');
const picked = (page: Page) => page.locator('.lrow[data-picked="true"] .lname b').allTextContents();

async function line(page: Page, y: number) {
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.15, r.y + r.height * y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(r.x + r.width * (0.15 + 0.04 * i), r.y + r.height * y);
  await page.mouse.up();
}
const dark = (page: Page, fy: number) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement, b) =>
  c.getContext("2d")!.getImageData(Math.round(c.width * 0.3), Math.round(c.height * b), 1, 1).data[0]! < 100, fy);

/** add see-through layers (a new layer starts white) */
async function addLayers(page: Page, n: number, draw?: (i: number) => Promise<void>) {
  for (let i = 0; i < n; i++) {
    await page.locator('[data-action="layer-add"]').click();
    await page.locator('.lrow.active [data-action="layer-color"]').click();
    await page.getByTestId("layer-color").locator('[data-paper="none"]').click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("layer-color")).toHaveCount(0);
    if (draw) await draw(i);
  }
}

test("tick several layers, hide and lock them together, delete them in one undo step", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await newWork(page);
  await addLayers(page, 3);
  expect(await names(page)).toEqual([name(4), name(3), name(2), name(1)]);

  await page.locator('[data-action="layer-pick"]').click();
  await expect(bulk(page)).toBeVisible();
  await expect(page.locator(".lfoot")).toBeHidden();
  await expect(page.locator(".lrow .lhandle")).toHaveCount(0);
  // the chosen layer starts ticked; taps tick and untick without changing the chosen layer
  expect(await picked(page)).toEqual([name(4)]);
  await row(page, 3).click();
  await row(page, 2).click();
  await row(page, 4).click();
  expect(await picked(page)).toEqual([name(3), name(2)]);
  await expect(page.getByTestId("layer-picked")).toHaveText(fill(th.layerPicked, { n: 2 }));
  await expect(page.getByTestId("layer-menu")).toHaveCount(0);

  await bulkBtn(page, "hide").click();
  await expect(row(page, 3).locator('[data-action="layer-eye"]')).toHaveAttribute("aria-pressed", "false");
  await expect(row(page, 2).locator('[data-action="layer-eye"]')).toHaveAttribute("aria-pressed", "false");
  await expect(row(page, 4).locator('[data-action="layer-eye"]')).toHaveAttribute("aria-pressed", "true");
  await expect(bulkBtn(page, "hide")).toHaveText(th.layerBulkShow);
  await bulkBtn(page, "hide").click();
  await expect(row(page, 3).locator('[data-action="layer-eye"]')).toHaveAttribute("aria-pressed", "true");

  // locked: no merge or delete until unlocked
  await bulkBtn(page, "lock").click();
  await expect(row(page, 3).locator(".llock")).toBeVisible();
  await expect(row(page, 2).locator(".llock")).toBeVisible();
  await expect(bulkBtn(page, "delete")).toBeDisabled();
  await expect(bulkBtn(page, "merge")).toBeDisabled();
  await expect(bulk(page)).toContainText(th.layerBulkLockedNote);
  await bulkBtn(page, "lock").click();
  await expect(row(page, 3).locator(".llock")).toHaveCount(0);

  await bulkBtn(page, "delete").click();
  expect(await names(page)).toEqual([name(4), name(1)]);
  await expect(bulk(page)).toBeHidden();
  await expect(page.locator(".lfoot")).toBeVisible();
  await expect(row(page, 4)).toHaveClass(/active/);
  // one undo brings both back
  await undoBtn(page).click();
  expect(await names(page)).toEqual([name(4), name(3), name(2), name(1)]);
  expect(errors).toEqual([]);
});

test("merge ticked layers into one, keeping all their drawing; one undo splits them again", async ({ page }) => {
  await newWork(page);
  await line(page, 0.3);
  await addLayers(page, 2, (i) => line(page, 0.5 + 0.2 * i));
  for (const y of [0.3, 0.5, 0.7]) expect(await dark(page, y)).toBe(true);

  await page.locator('[data-action="layer-pick"]').click();
  await row(page, 3).click(); // untick the chosen layer
  await expect(bulkBtn(page, "merge")).toBeDisabled(); // none ticked
  await row(page, 1).click();
  await expect(bulkBtn(page, "merge")).toBeDisabled(); // only one ticked
  await row(page, 2).click();
  await row(page, 3).click();
  await bulkBtn(page, "merge").click();
  expect(await names(page)).toEqual([name(1)]);
  await expect(row(page, 1)).toHaveClass(/active/);
  for (const y of [0.3, 0.5, 0.7]) expect(await dark(page, y)).toBe(true);

  await undoBtn(page).click();
  expect(await names(page)).toEqual([name(3), name(2), name(1)]);
  for (const y of [0.3, 0.5, 0.7]) expect(await dark(page, y)).toBe(true);
});

test("start from the layer menu; tick all; the back button stops choosing", async ({ page }) => {
  await newWork(page);
  await addLayers(page, 2);
  await row(page, 2).click({ button: "right" });
  await page.getByTestId("layer-menu").locator('[data-item="pick"]').click();
  expect(await picked(page)).toEqual([name(2)]);

  // all: at least one has to stay
  await bulk(page).locator('[data-action="pick-all"]').click();
  expect(await picked(page)).toEqual([name(3), name(2), name(1)]);
  await expect(bulkBtn(page, "delete")).toBeDisabled();
  await expect(bulkBtn(page, "merge")).toBeEnabled();
  await expect(bulk(page)).toContainText(th.layerBulkKeepOne);
  // again: none
  await bulk(page).locator('[data-action="pick-all"]').click();
  expect(await picked(page)).toEqual([]);
  await expect(page.getByTestId("layer-picked")).toHaveText(th.layerPickNone);
  await expect(bulkBtn(page, "hide")).toBeDisabled();

  // Android back: stop choosing, stay in the work
  await page.evaluate(() => history.back());
  await expect(bulk(page)).toBeHidden();
  await expect(page.getByTestId("paper")).toBeVisible();
  await expect(page.locator(".lrow .lhandle")).toHaveCount(3);
  // "done" works the same way
  await page.locator('[data-action="layer-pick"]').click();
  await bulk(page).locator('[data-action="pick-done"]').click();
  await expect(bulk(page)).toBeHidden();
});
