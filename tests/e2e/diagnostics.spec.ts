import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { th } from "../../src/i18n/th";

// M7c: the diagnostics page (measured while drawing, next to the spec's targets) and the error log.

const row = (page: Page, key: keyof typeof th) => page.locator(`#diagnostics dd[data-row="${key}"]`);
const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((acc, [k, x]) => acc.replace(`{${k}}`, String(x)), s);

async function newWork(page: Page) {
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
}

/** a pen stroke that takes a while, so its point rate can be measured */
async function penStroke(page: Page, cdp: CDPSession, y: number) {
  const r = (await page.getByTestId("paper").boundingBox())!;
  const at = (f: number): [number, number] => [r.x + r.width * f, r.y + r.height * y];
  const ev = (type: "mouseMoved" | "mousePressed" | "mouseReleased", [x, yy]: [number, number], buttons: number) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y: yy, button: "left", buttons, clickCount: 1, pointerType: "pen", force: 0.6 });
  await ev("mouseMoved", at(0.2), 0);
  await ev("mousePressed", at(0.2), 1);
  for (let i = 1; i <= 20; i++) { await ev("mouseMoved", at(0.2 + i * 0.02), 1); await page.waitForTimeout(12); }
  await ev("mouseReleased", at(0.6), 0);
}

test("from the gallery: version, screen, storage; strokes not measured yet", async ({ page }) => {
  await page.goto("./");
  await page.locator('[data-action="diagnostics"]').click();
  const dlg = page.locator("#diagnostics");
  await expect(dlg).toBeVisible();
  const version = (await page.getByTestId("version").textContent())!;
  expect(version).toContain((await row(page, "diagVersion").textContent())!);
  await expect(row(page, "diagPenRate")).toContainText(th.diagNoStrokes);
  await expect(row(page, "diagOpen")).toHaveText(th.diagOpenNone);
  await expect(row(page, "diagStorage")).toContainText("MB");
  await expect(row(page, "diagRefresh")).toContainText("Hz");
  await expect(page.getByTestId("diag-errors")).toContainText(th.diagErrorsNone);
  await dlg.locator('[data-action="dialog-close"]').click();
  await expect(dlg).toHaveCount(0);
});

test("after drawing with the pen: point rate, frames, open time and layer memory, then copy the report", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("./");
  await newWork(page);
  const cdp = await page.context().newCDPSession(page);
  for (const y of [0.3, 0.5]) await penStroke(page, cdp, y);

  await page.locator('[data-action="settings"]').click();
  await page.locator('#settings [data-action="diagnostics"]').click();
  await expect(page.locator("#settings")).toHaveCount(0);
  await expect(page.locator("#diagnostics")).toBeVisible();
  await expect(row(page, "diagPenRate")).toContainText(/\d+/);
  await expect(row(page, "diagPenRate")).not.toContainText(th.diagNoStrokes);
  await expect(row(page, "diagFps")).toContainText(fill(th.diagFpsValue, { n: "" }).trim());
  await expect(row(page, "diagStrokes")).toHaveText("2");
  await expect(row(page, "diagOpen")).toContainText(/\d/);
  await expect(row(page, "diagLayersMem")).toContainText("400 MB");

  await page.locator('[data-action="diag-copy"]').click();
  await expect(page.locator(".toast")).toHaveText(th.diagCopied);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain(th.diagTitle);
  expect(text).toContain(th.diagPenRate);
});

test("an error nobody caught: a notice that saved work is safe, kept in the log, cleared on request", async ({ page }) => {
  await page.goto("./");
  await page.evaluate(() => {
    console.error(new Error("จับได้แล้ว"));
    setTimeout(() => { throw new Error("พังทดสอบ"); }, 0);
  });
  const crash = page.getByTestId("crash");
  await expect(crash).toBeVisible();
  await expect(crash).toContainText(th.crashText);
  await crash.locator('[data-action="crash-close"]').click();
  await expect(crash).toHaveCount(0);

  await page.locator('[data-action="diagnostics"]').click();
  const log = page.getByTestId("diag-errors");
  await expect(log).toContainText("พังทดสอบ");
  await expect(log).toContainText("จับได้แล้ว");
  await expect(log.locator("li.crash")).toHaveCount(1);
  await expect(log.locator("li.logged")).toHaveCount(1);
  // kept after a reload
  await page.reload();
  await page.locator('[data-action="diagnostics"]').click();
  await expect(page.getByTestId("diag-errors").locator("li")).toHaveCount(2);
  await page.locator('[data-action="diag-clear"]').click();
  await expect(page.getByTestId("diag-errors")).toContainText(th.diagErrorsNone);

  // the reload button reloads
  await page.locator('#diagnostics [data-action="dialog-close"]').click();
  await page.evaluate(() => { setTimeout(() => { throw new Error("อีกครั้ง"); }, 0); });
  await Promise.all([page.waitForEvent("load"), page.getByTestId("crash").locator('[data-action="crash-reload"]').click()]);
  await expect(page.getByTestId("crash")).toHaveCount(0);
});
