import {defineConfig} from "@playwright/test";

// E2 is never a preview or production browser test. Keep the target fixed to
// the GitHub runner's loopback Next.js process rather than accepting a URL.
const baseURL = "http://127.0.0.1:3000";
if (process.env.PLAYWRIGHT_BASE_URL &&
    process.env.PLAYWRIGHT_BASE_URL !== baseURL) {
  throw new Error("E2 Playwright is restricted to local Next.js");
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "owner-journeys.spec.mjs",
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 45_000,
  expect: {timeout: 15_000},
  reporter: [
    ["line"],
    ["json", {outputFile: "test-results/e2e/results.json"}],
  ],
  use: {
    baseURL,
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
