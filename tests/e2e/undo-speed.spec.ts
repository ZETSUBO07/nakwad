import { expect, test, type Page } from "@playwright/test";

// Undo and redo redraw only the layer they change, not every layer (two-finger taps in a row stayed jerky).

async function newWork(page: Page) {
  await page.goto("./");
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
  await page.getByTestId("toolbar").locator('[data-field="size"]').fill("24");
}
async function line(page: Page, y: number) {
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.15, r.y + r.height * y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(r.x + r.width * (0.15 + 0.05 * i), r.y + r.height * y);
  await page.mouse.up();
}
const redraws = (page: Page) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement) => Number(c.dataset.redraws ?? "0"));
const dark = (page: Page, fy: number) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement, b) =>
  c.getContext("2d")!.getImageData(Math.round(c.width * 0.4), Math.round(c.height * b), 1, 1).data[0]! < 100, fy);
const undoBtn = (page: Page) => page.getByTestId("toolbar").locator('[data-action="undo"]');
const redoBtn = (page: Page) => page.getByTestId("toolbar").locator('[data-action="redo"]');

test("with six layers, each undo or redo of a stroke redraws one layer, and the picture stays right", async ({ page }) => {
  await newWork(page);
  // six see-through layers first, then a line on each (so the last steps are all strokes)
  for (let i = 1; i < 6; i++) {
    await page.locator('[data-action="layer-add"]').click();
    await page.locator('.lrow.active [data-action="layer-color"]').click();
    await page.getByTestId("layer-color").locator('[data-paper="none"]').click();
    await page.keyboard.press("Escape");
  }
  for (let i = 0; i < 6; i++) {
    await page.locator(".lrow").nth(5 - i).click();
    await expect(page.locator(".lrow").nth(5 - i)).toHaveClass(/active/);
    await line(page, 0.15 + i * 0.14);
  }
  for (let i = 0; i < 6; i++) expect(await dark(page, 0.15 + i * 0.14)).toBe(true);

  const r0 = await redraws(page);
  await undoBtn(page).click();
  expect(await redraws(page)).toBe(r0 + 1);
  expect(await dark(page, 0.85)).toBe(false);
  for (let i = 0; i < 5; i++) expect(await dark(page, 0.15 + i * 0.14)).toBe(true);

  // two fingers tapped quickly, three times: three steps back, one layer each
  const r = (await page.getByTestId("paper").boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const pts = [{ x: r.x + 200, y: r.y + 200, id: 0, radiusX: 8, radiusY: 8 }, { x: r.x + 300, y: r.y + 200, id: 1, radiusX: 8, radiusY: 8 }];
  for (let k = 0; k < 3; k++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts.slice(0, 1) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(80);
  }
  await expect.poll(() => redraws(page)).toBe(r0 + 1 + 3);

  await redoBtn(page).click();
  expect(await redraws(page)).toBe(r0 + 5);
  // what shows matches the history: three lines, then the fourth back again; the rest gone
  for (let i = 0; i < 6; i++) expect(await dark(page, 0.15 + i * 0.14)).toBe(i < 3);
});
