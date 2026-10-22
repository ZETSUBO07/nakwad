import { expect, test, type Page } from "@playwright/test";
import { th } from "../../src/i18n/th";

// M6.5: pictures, and the frame that moves, scales and turns a layer (spec "กรอบปรับรูป").

async function newWork(page: Page) {
  await page.goto("./");
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
}

/** a 300×100 picture: red on the left third, blue elsewhere, made in the browser */
async function picture(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(300, 100), x = c.getContext("2d")!;
    x.fillStyle = "#2f54d6"; x.fillRect(0, 0, 300, 100);
    x.fillStyle = "#e23b3b"; x.fillRect(0, 0, 100, 100);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    let s = ""; for (const v of bytes) s += String.fromCharCode(v);
    return btoa(s);
  });
  return Buffer.from(b64, "base64");
}

const frame = (page: Page) => page.getByTestId("transform-frame");
const toolbar = (page: Page) => page.getByTestId("toolbar");
const undoBtn = (page: Page) => toolbar(page).locator('[data-action="undo"]');
/** colour of the paper canvas at a screen point */
const at = (page: Page, x: number, y: number) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement, [sx, sy]) => {
  const r = c.getBoundingClientRect();
  return [...c.getContext("2d")!.getImageData(Math.round((sx! - r.left) * c.width / r.width), Math.round((sy! - r.top) * c.height / r.height), 1, 1).data];
}, [x, y]);
const isRed = (p: number[]) => p[0]! > 200 && p[1]! < 100;
const isBlue = (p: number[]) => p[2]! > 180 && p[0]! < 100;
const isWhite = (p: number[]) => p.slice(0, 3).every((v) => v > 245);

async function dragBy(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

test("a picture comes in as a new layer with the frame on it; dragging moves it, all one undo step", async ({ page }) => {
  await newWork(page);
  await page.locator('[data-field="image-file"]').setInputFiles({ name: "แมว.png", mimeType: "image/png", buffer: await picture(page) });
  await expect(frame(page)).toBeVisible();
  expect(await page.locator(".lrow .lname b").first().textContent()).toBe("แมว");
  const f = (await frame(page).boundingBox())!;
  expect(f.width / f.height).toBeCloseTo(3, 1);
  const cx = f.x + f.width / 2, cy = f.y + f.height / 2;
  expect(isBlue(await at(page, cx, cy))).toBe(true);
  expect(isRed(await at(page, f.x + f.width / 6, cy))).toBe(true);

  await dragBy(page, cx, cy, 120, 80);
  await dragBy(page, cx + 120, cy + 80, 60, 0);
  expect(isWhite(await at(page, f.x + 5, f.y + 5))).toBe(true);
  expect(isBlue(await at(page, cx + 180, cy + 80))).toBe(true);
  await page.keyboard.press("Enter"); // done
  await expect(frame(page)).toHaveCount(0);
  await undoBtn(page).click(); // both drags were one step
  expect(isBlue(await at(page, cx, cy))).toBe(true);
  await undoBtn(page).click(); // the picture itself
  expect(isWhite(await at(page, cx, cy))).toBe(true);
});

test("a corner scales keeping the proportions; the handle on top turns and snaps to right angles", async ({ page }) => {
  await newWork(page);
  await page.locator('[data-field="image-file"]').setInputFiles({ name: "p.png", mimeType: "image/png", buffer: await picture(page) });
  const f = (await frame(page).boundingBox())!;
  const se = (await frame(page).locator(".tgrip.se").boundingBox())!;
  await dragBy(page, se.x + se.width / 2, se.y + se.height / 2, 90, 30);
  const g = (await frame(page).boundingBox())!;
  expect(g.width).toBeGreaterThan(f.width * 1.2);
  expect(g.width / g.height).toBeCloseTo(3, 1);
  expect(g.x).toBeCloseTo(f.x, -1); // the opposite corner stays put

  const rot = (await frame(page).locator(".tgrip.rotate").boundingBox())!;
  const c = [g.x + g.width / 2, g.y + g.height / 2] as const;
  // drag the handle round to the right of the middle, a little off: it snaps to 90°
  await page.mouse.move(rot.x + rot.width / 2, rot.y + rot.height / 2);
  await page.mouse.down();
  await page.mouse.move(c[0] + 200, c[1] - 30, { steps: 10 });
  await expect(frame(page)).toHaveAttribute("data-turn", "81"); // not close enough yet
  await page.mouse.move(c[0] + 200, c[1] - 8, { steps: 4 });
  await page.mouse.up();
  await expect(frame(page)).toHaveAttribute("data-turn", "90");
  const h = (await frame(page).boundingBox())!;
  expect(h.height).toBeGreaterThan(h.width * 2); // now standing up
  // red third is now on top
  expect(isRed(await at(page, c[0], h.y + h.height / 6))).toBe(true);
  // kept after reopening
  await page.locator('[data-action="frame-done"]').click();
  await expect(page.getByTestId("save")).toHaveText(th.saveSaved, { timeout: 8000 });
  await page.locator('[data-action="gallery"]').click();
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await expect.poll(async () => isRed(await at(page, c[0], h.y + h.height / 6))).toBe(true);
});

test("move tool (V) on a drawn layer; empty and locked layers say why not", async ({ page }) => {
  await newWork(page);
  await page.keyboard.press("v");
  await expect(page.locator(".toast")).toHaveText(th.moveEmpty.replace("{name}", th.layerDefaultName.replace("{n}", "1")));
  await expect(frame(page)).toHaveCount(0);
  await toolbar(page).locator('[data-field="size"]').fill("40");
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.move(r.x + 200, r.y + 200);
  await page.mouse.down();
  await page.mouse.move(r.x + 400, r.y + 220, { steps: 8 });
  await page.mouse.up();
  await toolbar(page).locator('[data-action="move"]').click();
  await expect(frame(page)).toBeVisible();
  await expect(toolbar(page).locator('[data-action="move"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(frame(page)).toHaveCount(0);
  await page.locator(".lrow").first().click({ button: "right" });
  await page.getByTestId("layer-menu").locator('[data-item="lock"]').click();
  await page.keyboard.press("v");
  await expect(page.locator(".toast")).toHaveText(th.layerIsLocked.replace("{name}", th.layerDefaultName.replace("{n}", "1")));
  await expect(frame(page)).toHaveCount(0);
});

test("a turned text stays text you can edit", async ({ page }) => {
  await newWork(page);
  await toolbar(page).locator('[data-action="text"]').click();
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.click(r.x + r.width * 0.4, r.y + r.height * 0.4);
  await expect(page.getByTestId("text-box")).toBeFocused();
  await page.keyboard.type("TURN ME");
  await page.getByTestId("text-panel").locator('[data-action="text-done"]').click();
  await page.keyboard.press("v");
  const g = (await frame(page).boundingBox())!, rot = (await frame(page).locator(".tgrip.rotate").boundingBox())!;
  const c = [g.x + g.width / 2, g.y + g.height / 2] as const;
  await page.mouse.move(rot.x + rot.width / 2, rot.y + rot.height / 2);
  await page.mouse.down();
  await page.mouse.move(c[0] + 200, c[1] + 2, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.press("Enter");
  await page.keyboard.press("t");
  await page.mouse.click(c[0], c[1]);
  await expect(page.getByTestId("text-box")).toHaveValue("TURN ME");
  await expect(page.getByTestId("text-panel").locator(".tslider output")).toHaveText("90°");
});
