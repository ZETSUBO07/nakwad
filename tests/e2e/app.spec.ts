import { expect, test, type Page } from "@playwright/test";
import { th } from "../../src/i18n/th";

// The app itself: gallery, new work, drawing, saving, reopening, crash recovery, one window per work.

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  return errors;
}

async function newWork(page: Page, opts: { size?: string; paper?: string } = {}) {
  await page.locator('[data-action="new-work"]').click();
  const dlg = page.locator("#new-work");
  await expect(dlg).toBeVisible();
  if (opts.size) await dlg.getByRole("radio", { name: new RegExp(opts.size) }).first().click();
  if (opts.paper) await dlg.locator(`[data-paper="${opts.paper}"]`).click();
  await dlg.locator('[data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
}

/** a wavy line across the middle of the paper with the mouse */
async function scribble(page: Page, dy = 0) {
  const r = (await page.getByTestId("paper").boundingBox())!;
  const y = r.y + r.height / 2 + dy;
  await page.mouse.move(r.x + r.width * 0.2, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(r.x + r.width * (0.2 + 0.03 * i), y + Math.sin(i / 3) * 20);
  await page.mouse.up();
}

/** pixels on the paper canvas darker than `dark` in every channel */
const inked = (page: Page, dark = 90) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement, d) => {
  const x = c.getContext("2d")!, px = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i]! < d && px[i + 1]! < d && px[i + 2]! < d) n++;
  return n;
}, dark);
const corner = (page: Page) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement) => [...c.getContext("2d")!.getImageData(3, 3, 1, 1).data]);

const saved = (page: Page) => expect(page.getByTestId("save")).toHaveText(th.saveSaved, { timeout: 8000 });

test("make a work, draw, save, and find it again after a reload", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("./");
  await expect(page.locator(".gempty")).toHaveText(th.galleryEmpty);
  await newWork(page, { size: th.paper_portrait, paper: "cream" });
  expect(await corner(page)).toEqual([0xfb, 0xf7, 0xee, 255]);
  await expect(page.locator(".work-name")).toHaveText(th.workDefaultName.replace("{n}", "1"));
  await expect(page.locator('[data-action="undo"]')).toBeDisabled();
  await scribble(page);
  const ink = await inked(page);
  expect(ink).toBeGreaterThan(100);
  await expect(page.locator('[data-action="undo"]')).toBeEnabled();
  await saved(page);

  await page.locator('[data-action="gallery"]').click();
  const card = page.locator(".gcard[data-work]");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".gthumb img")).toBeVisible();

  await page.reload();
  await expect(card).toHaveCount(1);
  await card.locator('[data-action="open"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
  await expect.poll(() => inked(page)).toBeGreaterThan(ink * 0.8);
  // going back to the gallery folded the history into the work
  await expect(page.locator('[data-action="undo"]')).toBeDisabled();
  expect(errors).toEqual([]);
});

test("closing the app mid-work brings the undo history back", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("./");
  await newWork(page);
  await scribble(page, -60);
  const one = await inked(page);
  await scribble(page, 60);
  const two = await inked(page);
  expect(two).toBeGreaterThan(one * 1.5);
  await saved(page);

  await page.reload(); // as if the tablet closed the app
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await expect(page.locator(".toast")).toHaveText(th.workRecovered);
  await expect.poll(() => inked(page)).toBeGreaterThan(two * 0.9);
  await page.locator('[data-action="undo"]').click();
  await expect.poll(() => inked(page)).toBeLessThan(two * 0.75);
  await page.keyboard.press("Control+Shift+Z");
  await expect.poll(() => inked(page)).toBeGreaterThan(two * 0.9);
  expect(errors).toEqual([]);
});

test("the paper dialog checks sizes, swaps sides and remembers the last choice", async ({ page }) => {
  await page.goto("./");
  await page.locator('[data-action="new-work"]').click();
  const dlg = page.locator("#new-work");
  const w = dlg.locator('[data-field="w"]'), h = dlg.locator('[data-field="h"]'), start = dlg.locator('[data-action="start"]');
  await expect(w).toHaveValue("2400");
  await w.fill("7000");
  await expect(start).toBeDisabled();
  await expect(dlg.locator(".nw-info")).toHaveClass(/warn/);
  await w.fill("5000");
  await h.fill("4000");
  await expect(dlg.locator(".nw-info")).toHaveText(th.paperInvalid.replace("{min}", "64").replace("{max}", "6000")); // 20 million pixels is too many
  await expect(start).toBeDisabled();
  await h.fill("3000");
  await expect(start).toBeEnabled();
  await dlg.getByRole("button", { name: th.paperSwap }).click();
  await expect(w).toHaveValue("3000");
  await expect(h).toHaveValue("5000");
  await dlg.locator('[data-paper="none"]').click();
  await start.click();
  await expect(page.getByTestId("paper")).toBeVisible();
  // transparent paper shows the checkerboard
  const box = await page.getByTestId("paper").evaluate((c: HTMLCanvasElement) => { const r = c.getBoundingClientRect(); return [r.width / r.height]; });
  expect(box[0]).toBeCloseTo(3000 / 5000, 2);
  await page.locator('[data-action="gallery"]').click();

  await page.locator('[data-action="new-work"]').click();
  const last = dlg.locator(".psize.last");
  await expect(last).toHaveAttribute("aria-checked", "true");
  await expect(last).toContainText("3000 × 5000");
  await expect(dlg.locator('[data-paper="none"]')).toHaveAttribute("aria-checked", "true");
  await dlg.getByRole("button", { name: th.cancel }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(".gcard[data-work]")).toHaveCount(1);
});

test("rename, duplicate, and delete with a second press", async ({ page }) => {
  await page.goto("./");
  await newWork(page);
  await page.locator('[data-action="gallery"]').click();
  const cards = page.locator(".gcard[data-work]");

  await cards.first().locator('[data-action="rename"]').click();
  await page.getByRole("textbox", { name: th.workName }).fill("ทะเลยามเย็น");
  await page.keyboard.press("Enter");
  await expect(cards.first().locator("b")).toHaveText("ทะเลยามเย็น");

  await cards.first().locator('[data-action="duplicate"]').click();
  await expect(cards).toHaveCount(2);
  await expect(page.locator(".gtext b", { hasText: th.workCopyName.replace("{name}", "ทะเลยามเย็น") })).toHaveCount(1);

  const del = cards.first().locator('[data-action="delete"]');
  await del.click();
  await expect(del).toHaveClass(/armed/);
  await expect(cards).toHaveCount(2);
  await del.click();
  await expect(cards).toHaveCount(1);
});

test("a work open in one window cannot be opened in a second one", async ({ page, context }) => {
  await page.goto("./");
  await newWork(page);
  const other = await context.newPage();
  await other.goto("./");
  await other.locator('.gcard[data-work] [data-action="open"]').click();
  await expect(other.locator(".toast")).toHaveText(th.workLocked);
  await expect(other.getByTestId("paper")).toHaveCount(0);
  // once the first window goes back to the gallery, the second can open it
  await page.locator('[data-action="gallery"]').click();
  await expect(page.locator(".gcard[data-work]")).toHaveCount(1);
  await other.locator('.gcard[data-work] [data-action="open"]').click();
  await expect(other.getByTestId("paper")).toBeVisible();
});

test("two-finger tap undoes in the app too", async ({ page }) => {
  await page.goto("./");
  await newWork(page);
  await scribble(page);
  await expect(page.locator('[data-action="undo"]')).toBeEnabled();
  const r = (await page.getByTestId("paper").boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const pts = [{ x: r.x + 200, y: r.y + 200, id: 0, radiusX: 8, radiusY: 8 }, { x: r.x + 300, y: r.y + 200, id: 1, radiusX: 8, radiusY: 8 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts.slice(0, 1) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator('[data-action="undo"]')).toBeDisabled();
  expect(await inked(page)).toBe(0);
});

test("longer translated text still fits (pseudo language, every text 40% longer)", async ({ page }) => {
  // nothing may be cut: every button and label shows all of its text
  const cut = () => page.evaluate(() => [...document.querySelectorAll("button, label, h1, h2, p, b, small, output")]
    // work names are the user's own and end in "…" on purpose; everything else must fit
    .filter((e) => e.getClientRects().length && getComputedStyle(e).textOverflow !== "ellipsis" && e.scrollWidth > e.clientWidth + 1)
    .map((e) => e.textContent));
  await page.goto("./?lang=pseudo");
  await newWork(page);
  await page.getByTestId("toolbar").locator('[data-action="brush"]').click();
  expect(await cut()).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByTestId("toolbar").locator('[data-action="select"]').click();
  expect(await cut()).toEqual([]);
  await page.keyboard.press("Escape");
  await page.locator('[data-action="settings"]').click();
  expect(await cut()).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByTestId("toolbar").locator('[data-action="text"]').click();
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.click(r.x + r.width * 0.7, r.y + r.height * 0.5);
  await expect(page.getByTestId("text-panel")).toBeVisible();
  expect(await cut()).toEqual([]);
  await page.keyboard.press("Escape");
  await page.locator('[data-action="gallery"]').click();
  await page.locator('[data-action="new-work"]').click();
  expect(await cut()).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("tap the work's name in the top bar to type a new one", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("./");
  await newWork(page);
  await page.locator('[data-action="work-name"]').click();
  const input = page.locator('[data-field="work-name"]');
  await expect(input).toBeFocused();
  await page.keyboard.type("แมวส้ม"); // the old name is selected, so typing replaces it
  await page.keyboard.press("Enter");
  await expect(page.locator(".work-name")).toHaveText("แมวส้ม");
  // Escape leaves the name as it was; the keys typed do nothing else
  await page.locator('[data-action="work-name"]').click();
  await page.keyboard.type("s7");
  await page.keyboard.press("Escape");
  await expect(page.locator(".work-name")).toHaveText("แมวส้ม");
  await expect(page.getByTestId("toolbar").locator('[data-action="brush"]')).toHaveAttribute("data-brush", "pen");
  await scribble(page);
  await saved(page);
  await page.locator('[data-action="gallery"]').click();
  await expect(page.locator(".gcard[data-work] .gtext b")).toHaveText("แมวส้ม");
  await page.reload();
  await expect(page.locator(".gcard[data-work] .gtext b")).toHaveText("แมวส้ม");
  expect(errors).toEqual([]);
});
