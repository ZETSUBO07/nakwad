import { expect, test, type Page } from "@playwright/test";
import { th } from "../../src/i18n/th";

// M6.2: floating toolbar, brushes, colours, size and strength, settings.

async function newWork(page: Page) {
  await page.goto("./");
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
}

async function line(page: Page, y = 0.5, x0 = 0.15, x1 = 0.6) {
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.move(r.x + r.width * x0, r.y + r.height * y);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(r.x + r.width * (x0 + ((x1 - x0) * i) / 16), r.y + r.height * y);
  await page.mouse.up();
}

/** colour of the paper canvas at a fraction of its size */
const pixel = (page: Page, fx: number, fy: number) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement, [a, b]) =>
  [...c.getContext("2d")!.getImageData(Math.round(c.width * a!), Math.round(c.height * b!), 1, 1).data], [fx, fy]);

const toolbar = (page: Page) => page.getByTestId("toolbar");

test("pick a brush and a colour, draw, then erase with the 7 key", async ({ page }) => {
  await newWork(page);
  await toolbar(page).locator('[data-action="brush"]').click();
  const menu = page.getByTestId("brush-menu");
  await expect(menu.locator(".bopt")).toHaveCount(8);
  await menu.locator('[data-brush="nib"]').click();
  await expect(menu).toHaveCount(0);
  await expect(toolbar(page).locator('[data-action="brush"]')).toHaveAttribute("data-brush", "nib");
  await toolbar(page).locator('[data-color="#2f54d6"]').click();
  await line(page);
  const px = await pixel(page, 0.4, 0.5);
  expect(px[2]! > 150 && px[0]! < 120).toBe(true); // blue

  await page.keyboard.press("7");
  await expect(toolbar(page).locator('[data-action="brush"]')).toHaveAttribute("data-brush", "eraser");
  await line(page, 0.5, 0.1, 0.7);
  expect(await pixel(page, 0.4, 0.5)).toEqual([255, 255, 255, 255]);
  // picking a colour while erasing goes back to drawing
  await toolbar(page).locator('[data-color="#e23b3b"]').click();
  await expect(toolbar(page).locator('[data-action="brush"]')).toHaveAttribute("data-brush", "pen");
});

test("the size shows as a number and as a circle of the real size on the paper", async ({ page }) => {
  await newWork(page);
  await line(page, 0.3);
  const slider = toolbar(page).locator('[data-field="size"]');
  const ring = page.getByTestId("size-ring");
  await expect(ring).not.toHaveClass(/on/);
  const b = (await slider.boundingBox())!;
  await page.mouse.move(b.x + 4, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height / 2, { steps: 4 });
  const value = Number(await slider.inputValue());
  expect(value).toBeGreaterThan(30);
  await expect(toolbar(page).locator(".slider output").first()).toHaveText(String(value));
  await expect(ring).toHaveClass(/on/);
  await expect(ring.locator("span")).toHaveText(String(value));
  // the circle is the brush at the zoom the paper is shown at, where the pen last drew
  const paper = (await page.getByTestId("paper").boundingBox())!;
  const scale = paper.width / 2400;
  const rb = (await ring.boundingBox())!;
  expect(rb.width).toBeCloseTo(value * scale, -1);
  expect(rb.x + rb.width / 2).toBeCloseTo(paper.x + paper.width * 0.6, -1);
  expect(rb.y + rb.height / 2).toBeCloseTo(paper.y + paper.height * 0.3, -1);
  await page.mouse.up();
  await expect(ring).not.toHaveClass(/on/);
  // [ and ] change it too
  await page.keyboard.press("]");
  await expect(slider).toHaveValue(String(value + 2));
});

test("the toolbar folds, docks to the top, and is remembered", async ({ page }) => {
  await newWork(page);
  const bar = toolbar(page), grip = bar.locator('[data-action="grip"]');
  await expect(bar).toHaveAttribute("data-side", "right"); // left-handed by default: tools on the right
  await grip.click();
  await expect(bar).toHaveClass(/compact/);
  await expect(bar.locator(".swatches")).toBeHidden();
  await expect(bar.locator('[data-action="undo"]')).toBeVisible();
  await grip.click();
  await expect(bar).toHaveClass(/bubble/);
  await expect(bar.locator('[data-action="brush"]')).toBeHidden();
  await grip.click();
  await expect(bar).not.toHaveClass(/compact|bubble/);

  const g = (await grip.boundingBox())!;
  const work = (await page.locator(".work").boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(work.x + work.width / 2, work.y + 200, { steps: 6 });
  await page.mouse.move(work.x + work.width / 2, work.y + 20, { steps: 6 });
  await page.mouse.up();
  await expect(bar).toHaveAttribute("data-side", "top");
  await expect(bar).toHaveClass(/horizontal/);
  // the paper moved down out of its way
  const paper = (await page.getByTestId("paper").boundingBox())!, tb = (await bar.boundingBox())!;
  expect(paper.y).toBeGreaterThanOrEqual(tb.y + tb.height);

  await page.reload();
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await expect(toolbar(page)).toHaveAttribute("data-side", "top");
});

test("settings: hand, fingers, font style, smoothing", async ({ page }) => {
  await newWork(page);
  await page.locator('[data-action="settings"]').click();
  const dlg = page.locator("#settings");
  await dlg.locator('[data-field="hand"] [data-value="right"]').click();
  await expect(page.locator("body")).toHaveClass(/hand-right/);
  await expect(toolbar(page)).toHaveAttribute("data-side", "left");
  await dlg.locator('[data-field="font"] [data-value="brush"]').click();
  await expect(page.locator("body")).toHaveClass(/font-brush/);
  await dlg.locator('[data-field="stab"]').fill("60");
  await dlg.locator('[data-field="finger"] [data-value="draw"]').click();
  await dlg.getByRole("button", { name: th.close }).click();

  // one finger now draws
  const r = (await page.getByTestId("paper").boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const at = (x: number) => [{ x: r.x + r.width * x, y: r.y + r.height / 2, id: 0, radiusX: 6, radiusY: 6 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0.2) });
  for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(0.2 + i * 0.04) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(toolbar(page).locator('[data-action="undo"]')).toBeEnabled();

  await page.reload();
  await expect(page.locator("body")).toHaveClass(/font-brush/);
  await expect(page.locator("body")).toHaveClass(/hand-right/);
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await page.locator('[data-action="settings"]').click();
  await expect(page.locator('#settings [data-field="stab"]')).toHaveValue("60");
  await expect(page.locator('#settings [data-field="finger"] [data-value="draw"]')).toHaveAttribute("aria-checked", "true");
  await page.locator('#settings [data-action="toolbar-reset"]').click();
  await expect(page.locator(".toast")).toHaveText(th.setTbResetDone);
});

test("clear the layer, and undo it", async ({ page }) => {
  await newWork(page);
  await line(page);
  const px = await pixel(page, 0.4, 0.5);
  expect(px[0]!).toBeLessThan(100);
  await toolbar(page).locator('[data-action="clear"]').click();
  expect(await pixel(page, 0.4, 0.5)).toEqual([255, 255, 255, 255]);
  await toolbar(page).locator('[data-action="undo"]').click();
  expect((await pixel(page, 0.4, 0.5))[0]!).toBeLessThan(100);
});
