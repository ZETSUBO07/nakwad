import { expect, test, type Page } from "@playwright/test";

// The drawing engine, checked by pixels at known places in fixed scenes (see src/lab/scenes.ts).
// Pixel checks rather than whole-image comparisons, so small anti-aliasing changes between
// Chromium versions do not break the tests while real mistakes still do.

type Lab = { scene(n: string): Promise<{ w: number; h: number; widths?: Record<string, number> }>; rgba(x: number, y: number): number[]; countDark(x: number, y: number, w: number, h: number, dark?: number): number; wipe(): void };

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("./lab.html");
  await page.waitForFunction(() => "nakwadLab" in window);
  return errors;
}
const scene = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { nakwadLab: Lab }).nakwadLab.scene(n), name);
const rgba = (page: Page, x: number, y: number) => page.evaluate(([a, b]) => (window as unknown as { nakwadLab: Lab }).nakwadLab.rgba(a!, b!), [x, y]);
const dark = (page: Page, x: number, y: number, w: number, h: number, d = 100) =>
  page.evaluate(([a, b, c, e, f]) => (window as unknown as { nakwadLab: Lab }).nakwadLab.countDark(a!, b!, c!, e!, f!), [x, y, w, h, d]);
const near = (got: number[], want: number[], tol = 12) => want.every((v, i) => Math.abs((got[i] ?? -999) - v) <= tol);

test("every brush leaves its mark, and the two erasers behave differently", async ({ page }) => {
  const errors = await open(page);
  await scene(page, "brushes");
  // solid brushes: dark at the middle of their row
  for (const y of [30, 110, 150]) expect(near(await rgba(page, 300, y), [29, 34, 48]), `row ${y}`).toBe(true);
  // pencil and spray are textured: some dark grain, but far from solid
  for (const [y, h] of [[70, 12], [230, 30]] as const) {
    const n = await dark(page, 60, y - h / 2, 480, h, 160);
    expect(n, `grain at ${y}`).toBeGreaterThan(200);
    expect(n, `grain at ${y}`).toBeLessThan(480 * h * 0.8);
  }
  // marker multiplies its red onto white paper
  const m = await rgba(page, 300, 190);
  expect(m[0]! > 200 && m[1]! < 180 && m[2]! < 160).toBe(true);
  // the stroke eraser leaves the layer colour; erase-everything shows the paper
  expect(near(await rgba(page, 300, 290), [0xcf, 0xe3, 0xff])).toBe(true);
  expect(near(await rgba(page, 300, 350), [255, 255, 255])).toBe(true);
  // outside the erased part the band is still there
  expect(near(await rgba(page, 100, 290), [29, 34, 48])).toBe(true);
  expect(near(await rgba(page, 100, 350), [29, 34, 48])).toBe(true);
  expect(errors).toEqual([]);
});

test("a moved layer moves, and strokes stay sharp after the paper is resized", async ({ page }) => {
  await open(page);
  expect(await scene(page, "groups")).toMatchObject({ w: 600, h: 400 });
  // the 4 px line at y 50 on a 300×200 paper is now an 8 px line at y 100 on 600×400
  expect(near(await rgba(page, 300, 100), [29, 34, 48])).toBe(true);
  expect(near(await rgba(page, 300, 97), [29, 34, 48], 40)).toBe(true);
  expect(near(await rgba(page, 300, 108), [255, 255, 255])).toBe(true);
  // the moved stroke left its old place and shows 300 px to the right
  expect(near(await rgba(page, 100, 300), [255, 255, 255])).toBe(true);
  expect(near(await rgba(page, 400, 300), [29, 34, 48])).toBe(true);
});

test("text is drawn in the chosen font", async ({ page }) => {
  await open(page);
  const info = await scene(page, "text");
  const widths = info.widths ?? {};
  expect(widths.Mali).toBeGreaterThan(100);
  expect(Math.abs((widths.Mali ?? 0) - (widths.Anuphan ?? 0))).toBeGreaterThan(5);
  expect(await dark(page, 30, 30, 500, 90)).toBeGreaterThan(500);
  const red = await page.evaluate(() => {
    const lab = (window as unknown as { nakwadLab: Lab }).nakwadLab;
    let n = 0;
    for (let x = 30; x < 530; x += 2) for (let y = 210; y < 300; y += 2) { const p = lab.rgba(x, y); if (p[0]! > 180 && p[1]! < 120) n++; }
    return n;
  });
  expect(red).toBeGreaterThan(100);
});

test("selection erase and selection move", async ({ page }) => {
  await open(page);
  await scene(page, "selection");
  expect(near(await rgba(page, 150, 100), [0xfb, 0xf7, 0xee])).toBe(true); // erased: cream paper
  expect(near(await rgba(page, 300, 100), [29, 34, 48])).toBe(true); // untouched
  expect(near(await rgba(page, 450, 100), [0xfb, 0xf7, 0xee])).toBe(true); // lifted away
  expect(near(await rgba(page, 450, 300), [29, 34, 48])).toBe(true); // dropped 200 px lower
});

test("transparent paper shows a checkerboard", async ({ page }) => {
  await open(page);
  await scene(page, "transparent");
  const a = await rgba(page, 5, 5), b = await rgba(page, 15, 5);
  expect(a.join()).not.toBe(b.join());
});

test("after canvas memory is lost, the picture is drawn again from the data", async ({ page }) => {
  await open(page);
  await scene(page, "brushes");
  await page.evaluate(() => (window as unknown as { nakwadLab: Lab }).nakwadLab.wipe());
  expect(near(await rgba(page, 300, 30), [255, 255, 255])).toBe(true);
  await page.evaluate(() => document.querySelector("canvas")?.dispatchEvent(new Event("contextrestored")));
  expect(near(await rgba(page, 300, 30), [29, 34, 48])).toBe(true);
});

test("drawing with a pen in the lab", async ({ page }) => {
  const errors = await open(page);
  await page.setViewportSize({ width: 1200, height: 800 });
  const box = (await page.locator("canvas").boundingBox())!;
  const before = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i]! < 100) n++; return n;
  });
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + box.width * (0.3 + i * 0.02), box.y + box.height * 0.5);
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i]! < 100) n++; return n;
  });
  expect(after).toBeGreaterThan(before + 20);
  await expect(page.locator(".meter")).toContainText(/\d/);
  expect(errors).toEqual([]);
});
