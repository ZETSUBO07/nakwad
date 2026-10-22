import { defineConfig, devices } from "@playwright/test";

// CI installs its own Chromium; a local run can point at another build with PW_CHROMIUM.
const executablePath = process.env.PW_CHROMIUM || undefined;

export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:4173/nakwad/",
    trace: "retain-on-failure",
  },
  projects: [
    {
      // roughly the Xiaomi Pad 6S Pro in landscape (3048×2032 at 2× density)
      name: "tablet-landscape",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1524, height: 1016 }, hasTouch: true,
        // a UTF-8 locale, as on any phone or desktop: without it Chromium drops non-ASCII (Thai) download names
        launchOptions: { executablePath, env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } } },
    },
  ],
  webServer: {
    command: "npm run preview",
    url: "http://localhost:4173/nakwad/",
    reuseExistingServer: !process.env.CI,
  },
});
