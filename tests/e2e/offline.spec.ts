import { expect, test, type Page } from "@playwright/test";
import { th } from "../../src/i18n/th";

// M7a: the app installs, opens without a network, and a new version takes over the next time it opens.

test.use({ serviceWorkers: "allow" });

/** open the app and wait until the service worker runs it (the first visit only installs it) */
async function openControlled(page: Page) {
  await page.goto("./");
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(page.locator('[data-action="new-work"]')).toBeVisible();
}

async function drawSomething(page: Page) {
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
  await page.getByTestId("toolbar").locator('[data-field="size"]').fill("24");
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(r.x + r.width * (0.2 + 0.04 * i), r.y + r.height * 0.5);
  await page.mouse.up();
  await expect(page.getByTestId("save")).toHaveText(th.saveSaved, { timeout: 8000 });
}

const inkAt = (page: Page) => page.getByTestId("paper").evaluate((c: HTMLCanvasElement) =>
  c.getContext("2d")!.getImageData(Math.round(c.width * 0.4), Math.round(c.height * 0.5), 1, 1).data[0]!);

test("installable: the page links a manifest with the app's name, full screen and icons", async ({ page }) => {
  await page.goto("./");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  const m = await (await page.request.get(new URL(href!, page.url()).toString())).json() as Record<string, unknown>;
  expect(m).toMatchObject({ name: th.appName, short_name: th.appName, start_url: "/nakwad/", scope: "/nakwad/", display: "fullscreen", lang: "th" });
  const icons = m.icons as { src: string; sizes: string; purpose: string }[];
  expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
  for (const i of icons) expect((await page.request.get(new URL(i.src, new URL(href!, page.url())).toString())).ok()).toBe(true);
});

test("with no network the app still opens, and works are made, drawn and kept", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openControlled(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('[data-action="new-work"]')).toBeVisible();
  await expect(page.getByTestId("version")).toBeVisible();
  await drawSomething(page);
  expect(await inkAt(page)).toBeLessThan(100);
  await page.locator('[data-action="gallery"]').click();
  await page.reload();
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await expect.poll(() => inkAt(page)).toBeLessThan(100);
  // the brush lab is kept too
  await page.goto("./lab.html");
  await expect(page.locator("canvas").first()).toBeVisible();
  await context.setOffline(false);
  expect(errors).toEqual([]);
});

test("a text font is kept the first time it is used, so it also works without a network", async ({ page }) => {
  await openControlled(page);
  await page.locator('[data-action="new-work"]').click();
  await page.locator('#new-work [data-action="start"]').click();
  await expect(page.getByTestId("paper")).toBeVisible();
  await page.getByTestId("toolbar").locator('[data-action="text"]').click();
  const r = (await page.getByTestId("paper").boundingBox())!;
  await page.mouse.click(r.x + r.width * 0.3, r.y + r.height * 0.3);
  await expect(page.getByTestId("text-box")).toBeFocused();
  await page.keyboard.type("ก");
  await page.getByTestId("text-panel").locator('[data-font="Kanit"]').click();
  await expect.poll(() => page.evaluate(() => document.fonts.check('48px "Kanit"', "ก"))).toBe(true);
  await expect.poll(() => page.evaluate(async () => {
    const keys = await (await caches.open("nakwad-fonts")).keys();
    return keys.some((k) => /kanit-thai/.test(k.url));
  })).toBe(true);
});

test("a new version waits while a work is open, then takes over when the app is opened again; works stay", async ({ page: first, context }) => {
  // count page loads; once "next" is set, the worker's address changes, which the browser
  // treats like a newly published version
  await context.addInitScript(() => {
    localStorage.setItem("loads", String(Number(localStorage.getItem("loads") ?? "0") + 1));
    const register = ServiceWorkerContainer.prototype.register;
    ServiceWorkerContainer.prototype.register = function (url: string | URL, o?: RegistrationOptions) {
      return register.call(this, localStorage.getItem("next") ? `${String(url)}?next` : url, o);
    };
  });
  const loads = (p: Page) => p.evaluate(() => Number(localStorage.getItem("loads")));
  await openControlled(first);
  await drawSomething(first);
  expect(await first.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL)).toMatch(/\/sw\.js$/);

  // a new version is published and found while the work is open
  await first.evaluate(async () => {
    localStorage.setItem("next", "1");
    await navigator.serviceWorker.register("/nakwad/sw.js", { scope: "/nakwad/" });
  });
  await expect.poll(() => first.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);

  // still drawing: nothing reloads
  const before = await loads(first);
  await first.waitForTimeout(500);
  expect(await loads(first)).toBe(before);
  expect(await inkAt(first)).toBeLessThan(100);

  // the app is closed and opened again: it opens in the new version, and the work is still there
  await first.close();
  const page = await context.newPage();
  await page.goto("./");
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL)).toMatch(/\/sw\.js\?next$/);
  expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(false);
  expect(await loads(page)).toBe(before + 1);
  await page.locator('.gcard[data-work] [data-action="open"]').click();
  await expect.poll(() => inkAt(page)).toBeLessThan(100);
});

