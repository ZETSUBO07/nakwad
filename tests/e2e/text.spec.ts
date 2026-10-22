import { expect, test, type Page } from "@playwright/test";
import { th } from "../../src/i18n/th";

// M6.4: the text tool. Tap with T, type, fonts (built in and imported), edit any time, picture.

async function newWork(page: Page) {
  await page.goto("./");
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
}
const toolbar = (page: Page) => page.getByTestId("toolbar");
const box = (page: Page) => page.getByTestId("text-box");
const panel = (page: Page) => page.getByTestId("text-panel");
const names = (page: Page) => page.locator(".lrow .lname b").allTextContents();
const undoBtn = (page: Page) => toolbar(page).locator('[data-action="undo"]');

/** dark pixels on the whole paper canvas */
const inked = (page: Page) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement) => {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i]! < 120 && d[i + 1]! < 120 && d[i + 2]! < 120) n++;
  return n;
});

async function tapPaper(page: Page, fx: number, fy: number) {
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.click(r.x + r.width * fx, r.y + r.height * fy);
}

async function typeText(page: Page, text: string, at: [number, number] = [0.3, 0.4]) {
  await toolbar(page).locator('[data-action="text"]').click();
  await expect(toolbar(page).locator('[data-action="text"]')).toHaveAttribute("aria-pressed", "true");
  await tapPaper(page, ...at);
  await expect(box(page)).toBeFocused();
  await page.keyboard.type(text);
}

test("type a text: it gets its own layer, named after it; empty boxes make nothing", async ({ page }) => {
  await newWork(page);
  await toolbar(page).locator('[data-action="text"]').click();
  await tapPaper(page, 0.5, 0.5);
  await panel(page).locator('[data-action="text-done"]').click();
  expect(await names(page)).toEqual([th.layerDefaultName.replace("{n}", "1")]);

  await tapPaper(page, 0.3, 0.4);
  await page.keyboard.type("สวัสดี Hello");
  await panel(page).locator('[data-action="text-done"]').click();
  await expect(box(page)).toHaveCount(0);
  expect(await names(page)).toEqual(["สวัสดี Hello", th.layerDefaultName.replace("{n}", "1")]);
  const ink = await inked(page);
  expect(ink).toBeGreaterThan(300);
  await undoBtn(page).click();
  expect(await inked(page)).toBe(0);
  expect(await names(page)).toHaveLength(1);
});

test("tap a text to edit it: the change is one undo step, and it can be moved, deleted, rotated", async ({ page }) => {
  await newWork(page);
  await typeText(page, "AAAA");
  await page.keyboard.press("Escape"); // Escape also keeps the text
  const before = await inked(page);
  expect(before).toBeGreaterThan(100);

  await tapPaper(page, 0.32, 0.42);
  await expect(box(page)).toHaveValue("AAAA");
  expect(await inked(page)).toBe(0); // the original hides while its box is open
  await box(page).press("End");
  await page.keyboard.type("AAAA");
  await panel(page).locator('[data-field="text-size-number"]').fill("140");
  await panel(page).locator('[data-field="text-size-number"]').press("Enter");
  await panel(page).locator('[data-action="text-done"]').click();
  expect(await inked(page)).toBeGreaterThan(before * 3);
  await undoBtn(page).click();
  expect(await inked(page)).toBeCloseTo(before, -2);

  // drag the frame to move the box
  await tapPaper(page, 0.32, 0.42);
  const f = (await page.locator(".text-frame").boundingBox())!;
  await page.mouse.move(f.x + 4, f.y + 4);
  await page.mouse.down();
  await page.mouse.move(f.x + 204, f.y + 154, { steps: 6 });
  await page.mouse.up();
  const g = (await page.locator(".text-frame").boundingBox())!;
  expect(g.x - f.x).toBeCloseTo(200, -1);
  expect(g.y - f.y).toBeCloseTo(150, -1);
  // rotation snaps back to straight near 0
  await panel(page).locator('[data-field="text-rotate"]').fill("2");
  await expect(panel(page).locator(".tslider output")).toHaveText("0°");
  await panel(page).locator('[data-field="text-rotate"]').fill("30");
  await expect(panel(page).locator(".tslider output")).toHaveText("30°");
  await panel(page).locator('[data-action="text-done"]').click();

  // it is still text where it was moved to
  await page.mouse.click(g.x + g.width / 2, g.y + g.height / 2);
  await expect(box(page)).toHaveValue("AAAA");
  await panel(page).locator('[data-action="text-delete"]').click();
  expect(await inked(page)).toBe(0);
  await undoBtn(page).click();
  expect(await inked(page)).toBeGreaterThan(50);
});

test("fonts: the text tool's fonts load from our own site; the choice is kept with the text", async ({ page }) => {
  const outside: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith("http://localhost:4173/") && !r.url().startsWith("blob:http://localhost:4173/")) outside.push(r.url()); });
  await newWork(page);
  await typeText(page, "ก ข Kanit");
  await expect(panel(page).locator(".fontlist button")).toHaveCount(12);
  await panel(page).locator('[data-font="Kanit"]').click();
  await expect(panel(page).locator('[data-font="Kanit"]')).toHaveAttribute("aria-checked", "true");
  await panel(page).locator('[data-action="text-done"]').click();
  await expect.poll(() => page.evaluate(() => document.fonts.check('48px "Kanit"', "กข"))).toBe(true);
  // the next box starts with the last font
  await tapPaper(page, 0.6, 0.8);
  await expect(panel(page).locator('[data-font="Kanit"]')).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  await page.locator('[data-action="gallery"]').click();
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await toolbar(page).locator('[data-action="text"]').click();
  await tapPaper(page, 0.32, 0.42);
  await expect(box(page)).toHaveValue("ก ข Kanit");
  await expect(panel(page).locator('[data-font="Kanit"]')).toHaveAttribute("aria-checked", "true");
  expect(outside).toEqual([]);
});

test("import a font file; a file that is not a font is refused", async ({ page }) => {
  await newWork(page);
  await typeText(page, "Imported");
  const file = panel(page).locator('[data-field="font-file"]');
  await file.setInputFiles({ name: "notes.ttf", mimeType: "font/ttf", buffer: Buffer.from("this is not a font at all") });
  await expect(page.locator(".toast")).toHaveText(th.textImportNotFont);
  await file.setInputFiles({ name: "My Hand.woff2", mimeType: "font/woff2", buffer: await import("node:fs").then((fs) => fs.readFileSync("node_modules/@fontsource/itim/files/itim-latin-400-normal.woff2")) });
  await expect(page.locator(".toast")).toHaveText(th.textImported.replace("{name}", "My Hand"));
  await expect(panel(page).locator('[data-font="My Hand"]')).toHaveAttribute("aria-checked", "true");
  await panel(page).locator('[data-action="text-done"]').click();
  // still there after a reload
  await page.reload();
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await toolbar(page).locator('[data-action="text"]').click();
  await tapPaper(page, 0.32, 0.42);
  await expect(panel(page).locator('[data-font="My Hand"]')).toHaveAttribute("aria-checked", "true");
  await expect(panel(page).locator(".fontlist button")).toHaveCount(13);
});

test("turn a text into a picture: it stays after reopening, and is no longer edited as text", async ({ page }) => {
  await newWork(page);
  await typeText(page, "PICTURE");
  await panel(page).locator('[data-action="text-flatten"]').click();
  await expect(box(page)).toHaveCount(0);
  const ink = await inked(page);
  expect(ink).toBeGreaterThan(100);
  await expect(page.getByTestId("save")).toHaveText(th.saveSaved, { timeout: 8000 });
  await page.locator('[data-action="gallery"]').click();
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await expect.poll(() => inked(page)).toBeGreaterThan(ink * 0.8);
  await toolbar(page).locator('[data-action="text"]').click();
  await tapPaper(page, 0.32, 0.42);
  await expect(box(page)).toHaveValue(""); // a new box, not the old text
});

test("text on a locked layer cannot be edited", async ({ page }) => {
  await newWork(page);
  await typeText(page, "LOCKED");
  await panel(page).locator('[data-action="text-done"]').click();
  await page.locator(".lrow").first().click({ button: "right" });
  await page.getByTestId("layer-menu").locator('[data-item="lock"]').click();
  await tapPaper(page, 0.32, 0.42);
  await expect(page.locator(".toast")).toHaveText(th.layerIsLocked.replace("{name}", "LOCKED"));
  await expect(box(page)).toHaveCount(0);
});
