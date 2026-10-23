import { expect, test, type Page } from "@playwright/test";
import { th } from "../../src/i18n/th";

// M6.5c: the selection tool (rectangle, freehand, all, invert, none, delete, move, copy, cut).

async function newWork(page: Page) {
  await page.goto("./");
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
  await page.getByTestId("toolbar").locator('[data-field="size"]').fill("60");
}
const box = async (page: Page) => (await page.getByTestId("paper").boundingBox())!;
/** a thick line across the paper at height fy */
async function band(page: Page, fy = 0.5) {
  const r = await box(page);
  await page.mouse.move(r.x + r.width * 0.1, r.y + r.height * fy);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(r.x + r.width * (0.1 + 0.05 * i), r.y + r.height * fy);
  await page.mouse.up();
}
async function drag(page: Page, a: [number, number], b: [number, number]) {
  const r = await box(page);
  await page.mouse.move(r.x + r.width * a[0], r.y + r.height * a[1]);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * b[0], r.y + r.height * b[1], { steps: 6 });
  await page.mouse.up();
}
/** is the paper dark at this fraction of its size? */
const dark = (page: Page, fx: number, fy: number) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement, [a, b]) => {
  const d = c.getContext("2d")!.getImageData(Math.round(c.width * a!), Math.round(c.height * b!), 1, 1).data;
  return d[0]! < 100 && d[1]! < 100;
}, [fx, fy]);
const toolbar = (page: Page) => page.getByTestId("toolbar");
const undoBtn = (page: Page) => toolbar(page).locator('[data-action="undo"]');
const menuItem = async (page: Page, item: string) => {
  await toolbar(page).locator('[data-action="select"]').click();
  await page.getByTestId("select-menu").locator(`[data-item="${item}"]`).click();
};

test("rectangle select, Delete removes only what is inside, undo brings it back", async ({ page }) => {
  await newWork(page);
  await band(page);
  await page.keyboard.press("s");
  await expect(toolbar(page).locator('[data-action="select"]')).toHaveAttribute("aria-pressed", "true");
  await drag(page, [0.3, 0.3], [0.5, 0.7]);
  await expect(page.getByTestId("selection")).toHaveAttribute("data-state", "on");
  await page.keyboard.press("Delete");
  expect(await dark(page, 0.4, 0.5)).toBe(false);
  expect(await dark(page, 0.2, 0.5)).toBe(true);
  expect(await dark(page, 0.6, 0.5)).toBe(true);
  await undoBtn(page).click();
  expect(await dark(page, 0.4, 0.5)).toBe(true);
  // a tap clears the selection
  const r = await box(page);
  await page.mouse.click(r.x + r.width * 0.9, r.y + r.height * 0.1);
  await expect(page.getByTestId("selection")).toHaveAttribute("data-state", "none");
});

test("drag inside the selection to move those pixels; each drag is one undo step", async ({ page }) => {
  await newWork(page);
  await band(page);
  await page.keyboard.press("s");
  await drag(page, [0.3, 0.3], [0.5, 0.7]);
  await drag(page, [0.4, 0.5], [0.4, 0.8]);
  expect(await dark(page, 0.4, 0.5)).toBe(false);
  expect(await dark(page, 0.4, 0.8)).toBe(true);
  // the outline went with the pixels: dragging again moves them further
  await drag(page, [0.4, 0.8], [0.4, 0.9]);
  expect(await dark(page, 0.4, 0.9)).toBe(true);
  await undoBtn(page).click();
  await undoBtn(page).click();
  expect(await dark(page, 0.4, 0.5)).toBe(true);
});

test("with a selection, drawing only lands inside it", async ({ page }) => {
  await newWork(page);
  await page.keyboard.press("s");
  await drag(page, [0.3, 0.3], [0.5, 0.7]);
  await page.keyboard.press("1"); // back to the pen; the selection stays
  await band(page);
  expect(await dark(page, 0.4, 0.5)).toBe(true);
  expect(await dark(page, 0.2, 0.5)).toBe(false);
  expect(await dark(page, 0.7, 0.5)).toBe(false);
  await page.keyboard.press("Control+d");
  await band(page, 0.8);
  expect(await dark(page, 0.7, 0.8)).toBe(true);
});

test("freehand outline, select all, invert and none from the menu", async ({ page }) => {
  await newWork(page);
  await band(page);
  await menuItem(page, "lasso");
  const r = await box(page);
  // a triangle around the middle of the band
  const pts: [number, number][] = [[0.35, 0.35], [0.55, 0.35], [0.45, 0.7], [0.35, 0.36]];
  await page.mouse.move(r.x + r.width * pts[0]![0], r.y + r.height * pts[0]![1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(r.x + r.width * x, r.y + r.height * y, { steps: 8 });
  await page.mouse.up();
  await menuItem(page, "invert");
  await expect(page.getByTestId("selection")).toHaveAttribute("data-state", "inverted");
  await menuItem(page, "delete");
  expect(await dark(page, 0.44, 0.5)).toBe(true); // inside the triangle: kept
  expect(await dark(page, 0.2, 0.5)).toBe(false); // outside: gone
  await menuItem(page, "none");
  await expect(page.getByTestId("selection")).toHaveAttribute("data-state", "none");
  await toolbar(page).locator('[data-action="select"]').click();
  await expect(page.getByTestId("select-menu").locator('[data-item="delete"]')).toBeDisabled();
  await page.getByTestId("select-menu").locator('[data-item="all"]').click();
  await expect(page.getByTestId("selection")).toHaveAttribute("data-state", "on");
});

test("copy and cut to a new layer", async ({ page }) => {
  await newWork(page);
  await band(page);
  await page.keyboard.press("s");
  await drag(page, [0.3, 0.3], [0.5, 0.7]);
  await page.keyboard.press("Control+j");
  await expect(page.locator(".toast")).toHaveText(th.selectCopied);
  const names = () => page.locator(".lrow .lname b").allTextContents();
  const part = th.selectLayerName.replace("{name}", th.layerDefaultName.replace("{n}", "1"));
  expect(await names()).toEqual([part, th.layerDefaultName.replace("{n}", "1")]);
  await expect(page.locator(".lrow").first()).toHaveClass(/active/);
  // hide the original: the copy alone still shows inside the selection only
  await page.locator(".lrow").nth(1).locator('[data-action="layer-eye"]').click();
  expect(await dark(page, 0.4, 0.5)).toBe(true);
  expect(await dark(page, 0.2, 0.5)).toBe(false);
  await page.locator(".lrow").nth(1).locator('[data-action="layer-eye"]').click();

  await page.locator(".lrow").nth(1).locator(".lname").click();
  await menuItem(page, "cut");
  await expect(page.locator(".toast")).toHaveText(th.selectCutDone);
  await expect(page.locator(".lrow")).toHaveCount(3);
  await page.locator(".lrow").nth(1).locator('[data-action="layer-eye"]').click(); // hide the new cut layer
  await page.locator(".lrow").nth(0).locator('[data-action="layer-eye"]').click(); // and the first copy
  expect(await dark(page, 0.4, 0.5)).toBe(false); // cut out of the original
  expect(await dark(page, 0.2, 0.5)).toBe(true);
});

test("a locked layer refuses moving and deleting the selection", async ({ page }) => {
  await newWork(page);
  await band(page);
  await page.locator(".lrow").first().click({ button: "right" });
  await page.getByTestId("layer-menu").locator('[data-item="lock"]').click();
  await page.keyboard.press("s");
  await drag(page, [0.3, 0.3], [0.5, 0.7]);
  await page.keyboard.press("Delete");
  await expect(page.locator(".toast")).toHaveText(th.layerIsLocked.replace("{name}", th.layerDefaultName.replace("{n}", "1")));
  expect(await dark(page, 0.4, 0.5)).toBe(true);
  await drag(page, [0.4, 0.5], [0.4, 0.8]);
  expect(await dark(page, 0.4, 0.5)).toBe(true);
});
