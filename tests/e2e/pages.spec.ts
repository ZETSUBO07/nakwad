import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { th } from "../../src/i18n/th";

// M6.5b: several pages, changing the paper after the work exists, and Export.

async function newWork(page: Page) {
  await page.goto("./");
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
  await page.getByTestId("toolbar").locator('[data-field="size"]').fill("30");
}
async function line(page: Page, fy = 0.5) {
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * fy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(r.x + r.width * (0.2 + 0.05 * i), r.y + r.height * fy);
  await page.mouse.up();
}
const inked = (page: Page) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement) => {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i]! < 100 && d[i + 1]! < 100 && d[i + 2]! < 100) n++;
  return n;
});
const corner = (page: Page) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement) => [...c.getContext("2d")!.getImageData(2, 2, 1, 1).data]);
const ratio = (page: Page) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement) => c.getBoundingClientRect().width / c.getBoundingClientRect().height);
const chips = (page: Page) => page.getByTestId("pages").locator(".pchip");
const undoBtn = (page: Page) => page.getByTestId("toolbar").locator('[data-action="undo"]');

test("pages: add one in another size, switch, each keeps its own drawing and undo; kept after reload", async ({ page }) => {
  await newWork(page);
  await line(page);
  const ink1 = await inked(page);
  await page.locator('[data-action="page-add"]').click();
  await page.locator('#new-page [data-w="1600"][data-h="2400"]').click();
  await page.locator('#new-page [data-action="page-create"]').click();
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(1)).toHaveAttribute("aria-selected", "true");
  expect(await ratio(page)).toBeCloseTo(1600 / 2400, 2);
  expect(await inked(page)).toBe(0);
  await expect(undoBtn(page)).toBeDisabled(); // its own history
  await line(page, 0.3);
  await chips(page).nth(0).click();
  expect(await ratio(page)).toBeCloseTo(2400 / 1600, 2);
  expect(await inked(page)).toBeCloseTo(ink1, -2);
  await undoBtn(page).click();
  expect(await inked(page)).toBe(0);
  await expect(page.getByTestId("save")).toHaveText(th.saveSaved, { timeout: 8000 });

  await page.reload();
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await chips(page).nth(1).click();
  expect(await inked(page)).toBeGreaterThan(100);
});

test("duplicate a page; delete needs a second press; the last page cannot be deleted", async ({ page }) => {
  await newWork(page);
  await line(page);
  const ink = await inked(page);
  await page.locator('[data-action="page-duplicate"]').click();
  await expect(chips(page)).toHaveCount(2);
  expect(await inked(page)).toBeCloseTo(ink, -2);
  await expect(page.locator(".lrow")).toHaveCount(1);
  const del = page.locator('[data-action="page-delete"]');
  await del.click();
  await expect(chips(page)).toHaveCount(2);
  await expect(page.locator(".toast")).toHaveText(th.pageDeleteArmed.replace("{n}", "2"));
  await del.click();
  await expect(chips(page)).toHaveCount(1);
  await expect(del).toBeDisabled();
});

test("paper: colour changes every page at once; resizing scales to fit or keeps at an anchor, and undoes", async ({ page }) => {
  await newWork(page);
  await line(page);
  await page.locator('[data-action="page-add"]').click();
  await page.locator('#new-page [data-action="page-create"]').click();
  await page.locator('[data-action="paper"]').click();
  await page.locator('#paper [data-paper="cream"]').click();
  expect(await corner(page)).toEqual([0xfb, 0xf7, 0xee, 255]);
  await page.locator("#paper").getByRole("button", { name: th.close }).click();
  await expect(undoBtn(page)).toBeDisabled(); // the colour is a setting, not a step
  await chips(page).nth(0).click();
  expect(await corner(page)).toEqual([0xfb, 0xf7, 0xee, 255]);

  const ink = await inked(page);
  await page.locator('[data-action="paper"]').click();
  await page.locator('#paper [data-w="1600"][data-h="2400"]').click();
  await page.locator('#paper [data-action="paper-apply"]').click();
  await expect(page.locator(".toast")).toHaveText(th.paperResized.replace("{w}", "1600").replace("{h}", "2400"));
  expect(await ratio(page)).toBeCloseTo(1600 / 2400, 2);
  expect(await inked(page)).toBeGreaterThan(ink * 0.2); // scaled down to fit, still there
  await undoBtn(page).click();
  expect(await ratio(page)).toBeCloseTo(2400 / 1600, 2);

  // keep the size, anchored top-left: the drawing stays where it was on the paper
  await page.locator('[data-action="paper"]').click();
  await page.locator('#paper [data-field="w"]').fill("3000");
  await page.locator('#paper [data-field="h"]').fill("2000");
  await page.locator('#paper [data-field="fit"] [data-value="keep"]').click();
  await page.locator('#paper [data-anchor="0"]').click();
  await page.locator('#paper [data-action="paper-apply"]').click();
  expect(await ratio(page)).toBeCloseTo(1.5, 2);
  expect(await inked(page)).toBeGreaterThan(ink * 0.4);
});

test("export: this page as PNG and JPG, every page as one zip, the chosen layer", async ({ page }) => {
  await newWork(page);
  await line(page);
  await page.locator('[data-action="export"]').click();
  const dlg = page.locator("#export");
  await expect(dlg.locator(".xinfo")).toContainText("2400 × 1600");
  await expect(dlg.locator('[data-field="what"] [data-value="all"]')).toBeDisabled(); // one page only
  await dlg.locator('[data-field="name"]').fill("my/picture?");
  let dl = page.waitForEvent("download");
  await dlg.locator('[data-action="export-save"]').click();
  let file = await dl;
  expect(file.suggestedFilename()).toBe("mypicture.png");
  let bytes = readFileSync((await file.path())!);
  expect([...bytes.subarray(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(2400);

  await dlg.locator('[data-field="format"] [data-value="jpg"]').click();
  await dlg.locator('[data-field="scale"] [data-value="2x"]').click();
  await expect(dlg.locator(".xinfo")).toContainText("4800 × 3200");
  dl = page.waitForEvent("download");
  await dlg.locator('[data-action="export-save"]').click();
  file = await dl;
  expect(file.suggestedFilename()).toBe("mypicture.jpg");
  bytes = readFileSync((await file.path())!);
  expect(bytes[0]).toBe(0xff);
  await dlg.getByRole("button", { name: th.close }).click();

  await page.locator('[data-action="page-duplicate"]').click();
  await page.locator('[data-action="export"]').click();
  await dlg.locator('[data-field="what"] [data-value="all"]').click();
  await expect(dlg.locator(".xnote")).toContainText(th.exportNoteAll.replace("{n}", "2").split(" ")[0]!);
  dl = page.waitForEvent("download");
  await dlg.locator('[data-action="export-save"]').click();
  file = await dl;
  expect(file.suggestedFilename()).toBe(`${th.workDefaultName.replace("{n}", "1")}.zip`); // Thai names kept
  const zip = unzipSync(new Uint8Array(readFileSync((await file.path())!)));
  expect(Object.keys(zip).sort()).toEqual([`${th.workDefaultName.replace("{n}", "1")}-1.png`, `${th.workDefaultName.replace("{n}", "1")}-2.png`]);

  await dlg.locator('[data-field="what"] [data-value="layer"]').click();
  await expect(dlg.locator('[data-field="transparent"]')).toBeChecked(); // a single layer comes without paper
  await expect(dlg.locator(".xnote")).toContainText(th.layerDefaultName.replace("{n}", "1"));
});
