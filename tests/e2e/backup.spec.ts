import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { th } from "../../src/i18n/th";

// M7b: back up to .sketchbook (all works or one), restore, the reminder, sharing, and files shared to the app.

const DAY = 86_400_000;
const cards = (page: Page) => page.locator(".gcard[data-work]");
const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((acc, [k, x]) => acc.replace(`{${k}}`, String(x)), s);

async function makeWork(page: Page, name?: string) {
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
  await page.getByTestId("toolbar").locator('[data-field="size"]').fill("24");
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(r.x + r.width * (0.2 + 0.04 * i), r.y + r.height * 0.5);
  await page.mouse.up();
  if (name) {
    await page.locator('[data-action="work-name"]').click();
    await page.keyboard.type(name);
    await page.keyboard.press("Enter");
  }
  await expect(page.getByTestId("save")).toHaveText(th.saveSaved, { timeout: 8000 });
  await page.locator('[data-action="gallery"]').click();
  await expect(page.locator('[data-action="backup-all"]')).toBeVisible();
}

const inkAt = (page: Page) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement) =>
  c.getContext("2d")!.getImageData(Math.round(c.width * 0.4), Math.round(c.height * 0.5), 1, 1).data[0]!);

/** pretend the browser can share files, and record what was shared */
async function fakeShare(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { shared: string[] };
    w.shared = [];
    Object.defineProperty(navigator, "canShare", { value: (d: ShareData) => !!d.files?.length, configurable: true });
    Object.defineProperty(navigator, "share", { value: async (d: ShareData) => { w.shared.push(...(d.files ?? []).map((f) => `${f.name}:${f.size}`)); }, configurable: true });
  });
}
const shared = (page: Page) => page.evaluate(() => (window as unknown as { shared: string[] }).shared);

test("back up everything, then restore it into an empty gallery", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.getByTestId("last-backup")).toHaveText(th.backupNever);
  await makeWork(page, "แมว");
  await makeWork(page, "หมา");

  await page.locator('[data-action="backup-all"]').click();
  const dlg = page.locator("#file-ready");
  await expect(dlg).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), dlg.locator('[data-action="file-save"]').click()]);
  expect(download.suggestedFilename()).toMatch(/^nakwad-\d{4}-\d{2}-\d{2}\.sketchbook$/);
  const file = info.outputPath("all.sketchbook");
  await download.saveAs(file);
  await expect(page.getByTestId("last-backup")).not.toHaveText(th.backupNever);

  // the works go (deleted twice to confirm each), and come back from the file
  for (let i = 0; i < 2; i++) {
    const del = cards(page).first().locator('[data-action="delete"]');
    await del.click();
    await del.click();
  }
  await expect(cards(page)).toHaveCount(0);
  await page.locator('[data-field="restore-file"]').setInputFiles(file);
  await expect(page.locator(".toast").last()).toContainText(fill(th.restoreDone, { n: 2 }));
  await expect(cards(page)).toHaveCount(2);
  expect((await cards(page).locator(".gtext b").allTextContents()).sort()).toEqual(["หมา", "แมว"].sort());
  await cards(page).first().locator('[data-action="open"]').click();
  await expect.poll(() => inkAt(page)).toBeLessThan(100);
  expect(errors).toEqual([]);
});

test("back up one work; its file is named after it and holds only that work", async ({ page }, info) => {
  await page.goto("./");
  await makeWork(page, "ทะเล");
  await makeWork(page, "ภูเขา");
  const card = cards(page).filter({ hasText: "ทะเล" });
  await card.locator('[data-action="backup-work"]').click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator('#file-ready [data-action="file-save"]').click()]);
  expect(download.suggestedFilename()).toBe("ทะเล.sketchbook");
  // one work alone is not "everything backed up"
  await expect(page.getByTestId("last-backup")).toHaveText(th.backupNever);
  const file = info.outputPath("one.sketchbook");
  await download.saveAs(file);
  await page.locator('[data-field="restore-file"]').setInputFiles(file);
  await expect(page.locator(".toast").last()).toContainText(fill(th.restoreDone, { n: 1 }));
  await expect(cards(page).filter({ hasText: "ทะเล" })).toHaveCount(2);
  await expect(cards(page).filter({ hasText: "ภูเขา" })).toHaveCount(1);
});

test("a file that is not a backup is refused and nothing changes", async ({ page }) => {
  await page.goto("./");
  await makeWork(page);
  await page.locator('[data-field="restore-file"]').setInputFiles({ name: "notes.sketchbook", mimeType: "application/octet-stream", buffer: Buffer.from("not a zip at all") });
  await expect(page.locator(".toast").last()).toContainText(th.restoreBadFile);
  await expect(cards(page)).toHaveCount(1);
});

test("the reminder shows after 14 days without a backup when something changed, and goes after one", async ({ page }) => {
  await page.goto("./");
  await makeWork(page);
  await expect(page.getByTestId("backup-remind")).toBeHidden();
  await page.evaluate((t) => {
    const p = JSON.parse(localStorage.getItem("nakwad.prefs") ?? "{}") as Record<string, unknown>;
    localStorage.setItem("nakwad.prefs", JSON.stringify({ ...p, lastBackup: t }));
  }, Date.now() - 20 * DAY);
  await page.reload();
  // the work was changed after that old backup
  await expect(page.getByTestId("backup-remind")).toBeVisible();
  await expect(page.getByTestId("backup-remind")).toContainText(fill(th.backupRemind, { days: 14 }));
  await page.locator('[data-action="backup-now"]').click();
  await Promise.all([page.waitForEvent("download"), page.locator('#file-ready [data-action="file-save"]').click()]);
  await expect(page.getByTestId("backup-remind")).toBeHidden();
});

test("share: a backup and an exported picture go to the system share menu", async ({ page }) => {
  await fakeShare(page);
  await page.goto("./");
  await makeWork(page, "ลาย");
  await page.locator('[data-action="backup-all"]').click();
  await page.locator('#file-ready [data-action="file-share"]').click();
  await expect(page.locator("#file-ready")).toHaveCount(0);
  expect((await shared(page))[0]).toMatch(/^nakwad-.*\.sketchbook:\d+$/);
  await expect(page.getByTestId("last-backup")).not.toHaveText(th.backupNever);

  await cards(page).first().locator('[data-action="open"]').click();
  await page.locator('[data-action="export"]').click();
  const share = page.locator('#export [data-action="export-share"]');
  await expect(share).toBeEnabled();
  await share.click();
  await expect.poll(async () => (await shared(page)).length).toBe(2);
  expect((await shared(page))[1]).toMatch(/^ลาย\.png:\d+$/);
});

test.describe("files shared to the app", () => {
  test.use({ serviceWorkers: "allow" });

  test("a backup shared from another app is offered for restore, then added", async ({ page }, info) => {
    await page.goto("./");
    await makeWork(page, "ส่งมา");
    await page.locator('[data-action="backup-all"]').click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator('#file-ready [data-action="file-save"]').click()]);
    const file = info.outputPath("shared.sketchbook");
    await download.saveAs(file);

    // the installed app receives the file through its service worker (manifest share_target)
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const bytes = [...readFileSync(file)];
    const landed = await page.evaluate(async (b) => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(b)], "จากไลน์.sketchbook", { type: "application/octet-stream" }));
      const res = await fetch("/nakwad/share-target", { method: "POST", body: form });
      return res.url;
    }, bytes);
    expect(landed).toMatch(/\/nakwad\/\?shared=1$/);
    await page.goto("./?shared=1");
    const ask = page.locator("#restore-ask");
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("จากไลน์.sketchbook");
    expect(new URL(page.url()).search).toBe("");
    await ask.locator('[data-action="restore-ok"]').click();
    await expect(cards(page).filter({ hasText: "ส่งมา" })).toHaveCount(2);
    // taken once: opening the same address again asks nothing
    await page.goto("./?shared=1");
    await expect(page.locator('[data-action="backup-all"]')).toBeVisible();
    await expect(page.locator("#restore-ask")).toHaveCount(0);
  });
});
