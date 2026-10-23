import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { th } from "../../src/i18n/th";

// M6.3: the layer panel, its menu (long-press with finger or pen, right-click), lock, colour, drag to reorder.

const name = (n: number) => th.layerDefaultName.replace("{n}", String(n));

async function newWork(page: Page) {
  await page.goto("./");
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
  await expect(page.getByTestId("layers")).toBeVisible();
  // a wide pen, so a sampled pixel lands well inside the line
  await page.getByTestId("toolbar").locator('[data-field="size"]').fill("24");
}

const rows = (page: Page) => page.locator(".lrow");
/** layer names as the panel lists them, top to bottom */
const names = (page: Page) => page.locator(".lrow .lname b").allTextContents();
const row = (page: Page, n: number) => page.locator(".lrow", { has: page.locator(".lname b", { hasText: new RegExp(`^${name(n)}$`) }) });
const menu = (page: Page) => page.getByTestId("layer-menu");
const item = (page: Page, key: string) => menu(page).locator(`[data-item="${key}"]`);
const undoBtn = (page: Page) => page.getByTestId("toolbar").locator('[data-action="undo"]');

async function line(page: Page, y = 0.5) {
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.15, r.y + r.height * y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(r.x + r.width * (0.15 + 0.04 * i), r.y + r.height * y);
  await page.mouse.up();
}
const pixel = (page: Page, fx: number, fy: number) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement, [a, b]) =>
  [...c.getContext("2d")!.getImageData(Math.round(c.width * a!), Math.round(c.height * b!), 1, 1).data], [fx, fy]);

/** add layers and make them see-through (a new layer starts white) */
async function addLayers(page: Page, n: number) {
  for (let i = 0; i < n; i++) {
    await page.locator('[data-action="layer-add"]').click();
    await page.locator(".lrow.active [data-action=\"layer-color\"]").click();
    await page.getByTestId("layer-color").locator('[data-paper="none"]').click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("layer-color")).toHaveCount(0);
  }
}

test("a new layer starts white and covers what is below; its colour can be taken away", async ({ page }) => {
  await newWork(page);
  await line(page);
  expect((await pixel(page, 0.3, 0.5))[0]!).toBeLessThan(100);
  await page.locator('[data-action="layer-add"]').click();
  expect(await pixel(page, 0.3, 0.5)).toEqual([255, 255, 255, 255]);
  await expect(page.locator(".lrow.active .lbg .pdot")).not.toHaveClass(/pdot-none/);
  // one undo step takes the whole new layer away
  await undoBtn(page).click();
  expect(await names(page)).toEqual([name(1)]);
  expect((await pixel(page, 0.3, 0.5))[0]!).toBeLessThan(100);
});

test("tap the name of the chosen layer to type a new one; Escape keeps the old", async ({ page }) => {
  await newWork(page);
  await page.locator('[data-action="layer-add"]').click();
  // a tap on a layer that is not chosen only chooses it
  await row(page, 1).locator(".lname b").click();
  await expect(row(page, 1)).toHaveClass(/active/);
  await expect(page.locator('[data-field="layer-name"]')).toHaveCount(0);
  await row(page, 1).locator(".lname b").click();
  const input = page.locator('[data-field="layer-name"]');
  await expect(input).toBeFocused();
  await page.keyboard.type("ฉากหลัง"); // the old name is selected, so typing replaces it
  await page.keyboard.press("Enter");
  expect(await names(page)).toEqual([name(2), "ฉากหลัง"]);
  await rows(page).last().locator(".lname b").click();
  await page.keyboard.type("x");
  await page.keyboard.press("Escape");
  expect(await names(page)).toEqual([name(2), "ฉากหลัง"]);
  // typing a name never draws, switches tools or deletes anything
  await expect(page.getByTestId("toolbar").locator('[data-action="brush"]')).toHaveAttribute("data-brush", "pen");
});

test("add, choose, hide, set strength, and undo adding", async ({ page }) => {
  await newWork(page);
  await addLayers(page, 2);
  expect(await names(page)).toEqual([name(3), name(2), name(1)]);
  await expect(row(page, 3)).toHaveClass(/active/);
  await row(page, 1).locator(".lname").click();
  await expect(row(page, 1)).toHaveClass(/active/);
  await line(page);
  expect((await pixel(page, 0.3, 0.5))[0]!).toBeLessThan(100);
  await row(page, 1).locator('[data-action="layer-eye"]').click();
  expect(await pixel(page, 0.3, 0.5)).toEqual([255, 255, 255, 255]);
  // drawing on a hidden layer is refused with a message
  await line(page, 0.7);
  await expect(page.locator(".toast")).toContainText(name(1));
  await row(page, 1).locator('[data-action="layer-eye"]').click();
  await page.locator('[data-field="layer-opacity"]').fill("40");
  await expect(row(page, 1).locator(".lname small")).toHaveText("40%");
  const faint = await pixel(page, 0.3, 0.5);
  expect(faint[0]!).toBeGreaterThan(120);
  await undoBtn(page).click(); // the stroke (strength is a setting, not a step)
  await undoBtn(page).click(); // taking the white away from the second added layer
  await undoBtn(page).click(); // the second added layer
  expect(await names(page)).toEqual([name(2), name(1)]);
});

test("right-click menu: dimmed items, moves, duplicate, merge, rename, clear, delete, all undoable", async ({ page }) => {
  await newWork(page);
  await addLayers(page, 2); // panel: 3 2 1
  await row(page, 3).click({ button: "right" });
  await expect(item(page, "top")).toBeDisabled();
  await expect(item(page, "up")).toBeDisabled();
  await expect(item(page, "bottom")).toBeEnabled();
  await item(page, "bottom").click();
  await expect(menu(page)).toHaveCount(0);
  expect(await names(page)).toEqual([name(2), name(1), name(3)]);
  await undoBtn(page).click();
  expect(await names(page)).toEqual([name(3), name(2), name(1)]);

  await row(page, 2).click({ button: "right" });
  await item(page, "duplicate").click();
  const copy = th.layerCopyName.replace("{name}", name(2));
  expect(await names(page)).toEqual([name(3), copy, name(2), name(1)]);

  await row(page, 1).locator(".lname").click();
  await line(page, 0.3);
  await row(page, 3).locator(".lname").click();
  await line(page, 0.6);
  await row(page, 3).click({ button: "right" });
  await item(page, "merge").click();
  expect(await names(page)).toEqual([copy, name(2), name(1)]);
  // both strokes still show: merged into the copy below
  expect((await pixel(page, 0.3, 0.6))[0]!).toBeLessThan(100);

  await row(page, 2).click({ button: "right" });
  await item(page, "rename").click();
  await page.getByRole("textbox", { name: th.layerName }).fill("ฉากหลัง");
  await page.keyboard.press("Enter");
  expect(await names(page)).toEqual([copy, "ฉากหลัง", name(1)]);

  await row(page, 1).click({ button: "right" });
  await item(page, "clear").click();
  expect(await pixel(page, 0.3, 0.3)).toEqual([255, 255, 255, 255]);
  await undoBtn(page).click();
  expect((await pixel(page, 0.3, 0.3))[0]!).toBeLessThan(100);

  await row(page, 1).click({ button: "right" });
  await item(page, "delete").click();
  expect(await names(page)).toEqual([copy, "ฉากหลัง"]);
  await undoBtn(page).click();
  expect(await names(page)).toEqual([copy, "ฉากหลัง", name(1)]);
});

async function longPressTouch(cdp: CDPSession, x: number, y: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 0, radiusX: 6, radiusY: 6 }] });
  await new Promise((r) => setTimeout(r, 700));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function longPressPen(cdp: CDPSession, x: number, y: number) {
  const ev = (type: "mouseMoved" | "mousePressed" | "mouseReleased", buttons: number) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1, pointerType: "pen", force: 0.5 });
  await ev("mouseMoved", 0);
  await ev("mousePressed", 1);
  await new Promise((r) => setTimeout(r, 700));
  await ev("mouseReleased", 0);
}

test("a long press with a finger or the pen opens the menu; a short tap only chooses", async ({ page }) => {
  await newWork(page);
  await addLayers(page, 1);
  const cdp = await page.context().newCDPSession(page);
  const b = (await row(page, 1).locator(".lname").boundingBox())!;
  await longPressTouch(cdp, b.x + 10, b.y + b.height / 2);
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toHaveAttribute("aria-label", th.layerMenuOf.replace("{name}", name(1)));
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await longPressPen(cdp, b.x + 10, b.y + b.height / 2);
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.click(b.x + 10, b.y + b.height / 2);
  await expect(menu(page)).toHaveCount(0);
  await expect(row(page, 1)).toHaveClass(/active/);
});

test("drag a layer by its handle across three layers, or long-press and keep moving", async ({ page }) => {
  await newWork(page);
  await addLayers(page, 3); // panel: 4 3 2 1
  const h4 = (await row(page, 4).locator('[data-action="layer-drag"]').boundingBox())!;
  const r1 = (await row(page, 1).boundingBox())!;
  await page.mouse.move(h4.x + h4.width / 2, h4.y + h4.height / 2);
  await page.mouse.down();
  await page.mouse.move(h4.x + h4.width / 2, r1.y + r1.height * 0.6, { steps: 8 });
  await expect(page.locator(".ldrop")).toBeVisible();
  await page.mouse.up();
  expect(await names(page)).toEqual([name(3), name(2), name(1), name(4)]);
  await undoBtn(page).click(); // one step
  expect(await names(page)).toEqual([name(4), name(3), name(2), name(1)]);

  // with a finger: hold, then keep moving
  const cdp = await page.context().newCDPSession(page);
  const n1 = (await row(page, 1).locator(".lname").boundingBox())!;
  const top = (await row(page, 4).boundingBox())!;
  const at = (y: number) => [{ x: n1.x + 10, y, id: 0, radiusX: 6, radiusY: 6 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(n1.y + n1.height / 2) });
  await new Promise((r) => setTimeout(r, 650));
  await expect(menu(page)).toBeVisible();
  for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(n1.y + n1.height / 2 - ((n1.y - top.y) * i) / 10 - 6) });
  await expect(menu(page)).toHaveCount(0);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect(await names(page)).toEqual([name(1), name(4), name(3), name(2)]);
});

test("a locked layer cannot be drawn on, erased or cleared; the lock is kept", async ({ page }) => {
  await newWork(page);
  await line(page);
  await rows(page).first().click({ button: "right" });
  await item(page, "lock").click();
  await expect(rows(page).first().locator(".llock")).toBeVisible();
  // locking is a setting: nothing to undo for it
  const ink = await pixel(page, 0.3, 0.5);
  await line(page, 0.7);
  await expect(page.locator(".toast")).toHaveText(th.layerIsLocked.replace("{name}", name(1)));
  expect(await pixel(page, 0.3, 0.7)).toEqual([255, 255, 255, 255]);
  await page.keyboard.press("8"); // erase everything
  await line(page);
  expect(await pixel(page, 0.3, 0.5)).toEqual(ink);
  await page.getByTestId("toolbar").locator('[data-action="clear"]').click();
  expect(await pixel(page, 0.3, 0.5)).toEqual(ink);
  await rows(page).first().click({ button: "right" });
  await expect(item(page, "clear")).toBeDisabled();
  await expect(item(page, "delete")).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.locator('[data-action="gallery"]').click();
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await expect(rows(page).first().locator(".llock")).toBeVisible();
  await rows(page).first().click({ button: "right" });
  await item(page, "lock").click(); // unlock
  await expect(rows(page).first().locator(".llock")).toHaveCount(0);
  await page.keyboard.press("1");
  await line(page, 0.7);
  expect((await pixel(page, 0.3, 0.7))[0]!).toBeLessThan(100);
});

test("layer colour: presets, and a whole colour-wheel drag is one undo step", async ({ page }) => {
  await newWork(page);
  await rows(page).first().locator('[data-action="layer-color"]').click();
  const pop = page.getByTestId("layer-color");
  await pop.locator('[data-paper="cream"]').click();
  expect(await pixel(page, 0.9, 0.9)).toEqual([0xfb, 0xf7, 0xee, 255]);
  const wheel = pop.locator('input[type="color"]');
  await wheel.evaluate((el: HTMLInputElement) => {
    for (const v of ["#ff0000", "#00ff00", "#336699"]) { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(await pixel(page, 0.9, 0.9)).toEqual([0x33, 0x66, 0x99, 255]);
  await page.keyboard.press("Escape");
  await undoBtn(page).click();
  expect(await pixel(page, 0.9, 0.9)).toEqual([0xfb, 0xf7, 0xee, 255]);
  await undoBtn(page).click();
  expect(await pixel(page, 0.9, 0.9)).toEqual([255, 255, 255, 255]);
});

test("the panel can be closed and stays closed", async ({ page }) => {
  await newWork(page);
  await page.locator('[data-action="layers"]').click();
  await expect(page.getByTestId("layers")).toBeHidden();
  await page.reload();
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await expect(page.getByTestId("layers")).toBeHidden();
  await page.locator('[data-action="layers"]').click();
  await expect(page.getByTestId("layers")).toBeVisible();
});
