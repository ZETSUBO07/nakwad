import { expect, test, type CDPSession, type Page } from "@playwright/test";

// Pen, mouse and finger input in the brush lab, driven by real browser events through the
// Chrome DevTools Protocol (touch contacts with a size, and a pen with pressure).

type Vec = [number, number];
type View = { s: number; r: number; tx: number; ty: number };
type Frame = { center: Vec; fit: number; w: number; h: number };
type Lab = {
  view(): View; setView(v: View): void; frame(): Frame; strokes(): number;
  lastStroke(): [number, number, number, number][] | null; fingerMode(): string;
};
const lab = <T>(page: Page, fn: (l: Lab) => T) => page.evaluate(`(${fn.toString()})(window.nakwadLab)`) as Promise<T>;

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("./lab.html");
  await page.waitForFunction(() => "nakwadLab" in window);
  const cdp = await page.context().newCDPSession(page);
  return { errors, cdp };
}

/** the same maths as src/input/view.ts, written out again so the test checks it independently */
function toPaper(v: View, f: Frame, p: Vec): Vec {
  const dx = p[0] - f.center[0] - v.tx, dy = p[1] - f.center[1] - v.ty;
  const c = Math.cos(-v.r), s = Math.sin(-v.r), k = v.s * f.fit;
  return [(dx * c - dy * s) / k + f.w / 2, (dx * s + dy * c) / k + f.h / 2];
}

const steps = (a: Vec, b: Vec, n = 8): Vec[] => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);

async function penLine(cdp: CDPSession, a: Vec, b: Vec, force = 0.7) {
  const ev = (type: "mouseMoved" | "mousePressed" | "mouseReleased", [x, y]: Vec, buttons: number) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1, pointerType: "pen", force });
  await ev("mouseMoved", a, 0);
  await ev("mousePressed", a, 1);
  for (const p of steps(a, b).slice(1)) await ev("mouseMoved", p, 1);
  await ev("mouseReleased", b, 0);
}

type Touch = { x: number; y: number; id: number; radiusX?: number; radiusY?: number };
const touch = (cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", touchPoints: Touch[]) =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints });

/** fingers go down at `from`, move together to `to`, and lift */
async function fingers(cdp: CDPSession, from: Vec[], to: Vec[] = from, radius = 8, n = 8) {
  const at = (pts: Vec[]) => pts.map(([x, y], id) => ({ x, y, id, radiusX: radius, radiusY: radius }));
  // fingers land one after another, as real ones do
  for (let i = 1; i <= from.length; i++) await touch(cdp, "touchStart", at(from.slice(0, i)));
  if (to !== from) for (let k = 1; k <= n; k++) await touch(cdp, "touchMove", at(from.map((p, i) => steps(p, to[i]!, n)[k]!)));
  await touch(cdp, "touchEnd", []);
}

const near = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) <= tol);

test("mouse and pen strokes land under the pointer, also zoomed and turned 90°", async ({ page }) => {
  const { errors, cdp } = await open(page);
  const f = await lab(page, (l) => l.frame());
  const [cx, cy] = f.center;

  // at rest, with the mouse
  await page.mouse.move(cx - 100, cy - 50);
  await page.mouse.down();
  for (const [x, y] of steps([cx - 100, cy - 50], [cx + 120, cy + 40]).slice(1)) await page.mouse.move(x, y);
  await page.mouse.up();
  let pts = (await lab(page, (l) => l.lastStroke()))!;
  const rest: View = { s: 1, r: 0, tx: 0, ty: 0 };
  expect(near(pts[0]!.slice(0, 2), toPaper(rest, f, [cx - 100, cy - 50]), 1)).toBe(true);
  expect(near(pts.at(-1)!.slice(0, 2), toPaper(rest, f, [cx + 120, cy + 40]), 1)).toBe(true);

  // zoomed in, turned a quarter and moved, with the pen
  const v: View = { s: 2.5, r: Math.PI / 2, tx: 60, ty: -40 };
  await page.evaluate((v) => (window as unknown as { nakwadLab: Lab }).nakwadLab.setView(v), v);
  const a: Vec = [cx - 80, cy + 30], b: Vec = [cx + 90, cy - 70];
  await penLine(cdp, a, b, 0.7);
  pts = (await lab(page, (l) => l.lastStroke()))!;
  expect(near(pts[0]!.slice(0, 2), toPaper(v, f, a), 1)).toBe(true);
  expect(near(pts.at(-1)!.slice(0, 2), toPaper(v, f, b), 1)).toBe(true);
  expect(pts[2]![2]).toBeCloseTo(0.7, 1);
  expect(await lab(page, (l) => l.strokes())).toBe(2);
  expect(errors).toEqual([]);
});

test("two fingers zoom and keep the paper under them; a quick pinch-in fits the paper again", async ({ page }) => {
  const { errors, cdp } = await open(page);
  const f = await lab(page, (l) => l.frame());
  const [cx, cy] = f.center;
  const mid: Vec = [cx + 100, cy + 50];
  const under = toPaper({ s: 1, r: 0, tx: 0, ty: 0 }, f, mid);
  await fingers(cdp, [[mid[0] - 50, mid[1]], [mid[0] + 50, mid[1]]], [[mid[0] - 100, mid[1]], [mid[0] + 100, mid[1]]], 8, 12);
  const v = await lab(page, (l) => l.view());
  expect(v.s).toBeCloseTo(2, 1);
  expect(v.r).toBe(0);
  expect(near(toPaper(v, f, mid), under, 1.5)).toBe(true);
  await expect(page.locator('[data-action="zoom"]')).toHaveText(`${Math.round(v.s * f.fit * 100)}%`);
  expect(await lab(page, (l) => l.strokes())).toBe(0);

  await fingers(cdp, [[cx - 200, cy], [cx + 200, cy]], [[cx - 40, cy], [cx + 40, cy]], 8, 3);
  expect(await lab(page, (l) => l.view())).toEqual({ s: 1, r: 0, tx: 0, ty: 0 });
  expect(errors).toEqual([]);
});

test("two-finger tap undoes, three-finger tap redoes", async ({ page }) => {
  const { errors, cdp } = await open(page);
  const [cx, cy] = (await lab(page, (l) => l.frame())).center;
  await penLine(cdp, [cx - 100, cy], [cx + 100, cy]);
  await penLine(cdp, [cx - 100, cy + 40], [cx + 100, cy + 40]);
  expect(await lab(page, (l) => l.strokes())).toBe(2);
  await page.waitForTimeout(350); // past the resting-hand guard after the pen lifts
  await fingers(cdp, [[cx, cy], [cx + 80, cy]]);
  expect(await lab(page, (l) => l.strokes())).toBe(1);
  await fingers(cdp, [[cx, cy], [cx + 80, cy]]);
  expect(await lab(page, (l) => l.strokes())).toBe(0);
  await fingers(cdp, [[cx, cy], [cx + 80, cy], [cx + 160, cy]]);
  expect(await lab(page, (l) => l.strokes())).toBe(1);
  expect(errors).toEqual([]);
});

test("one finger draws only in finger-draw mode; palms and a hand resting after the pen do not", async ({ page }) => {
  const { errors, cdp } = await open(page);
  const [cx, cy] = (await lab(page, (l) => l.frame())).center;
  const swipe = (r = 8) => fingers(cdp, [[cx - 100, cy]], [[cx + 100, cy + 20]], r);

  await swipe();
  expect(await lab(page, (l) => l.strokes())).toBe(0);

  await page.locator('[data-action="finger-draw"]').click();
  expect(await lab(page, (l) => l.fingerMode())).toBe("draw");
  await expect(page.locator('[data-action="finger-draw"]')).toHaveAttribute("aria-pressed", "true");
  await swipe();
  expect(await lab(page, (l) => l.strokes())).toBe(1);

  await swipe(40); // an 80 px wide contact is a palm
  expect(await lab(page, (l) => l.strokes())).toBe(1);

  await penLine(cdp, [cx - 100, cy - 60], [cx + 100, cy - 60]);
  await swipe(); // straight after the pen: the side of the hand
  expect(await lab(page, (l) => l.strokes())).toBe(2);
  expect(errors).toEqual([]);
});
