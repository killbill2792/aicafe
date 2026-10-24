import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [phase, siteUrl] = process.argv.slice(2);
if (!["before", "after"].includes(phase) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(siteUrl ?? "")) {
  throw new Error("Usage: node scripts/redesign16-visual-compare.mjs before|after http://127.0.0.1:PORT");
}

const output = "docs/screenshots/redesign-16";
mkdirSync(output, { recursive: true });
const screens = [
  { id: "staff-mobile", route: "/en/staff?fixture=1&week=2026-10-26", width: 390, height: 844 },
  { id: "staff-desktop", route: "/en/staff?fixture=1&week=2026-10-26", width: 1440, height: 900 },
  { id: "more-mobile", route: "/en/more", width: 390, height: 844 },
  { id: "more-desktop", route: "/en/more", width: 1440, height: 900 },
];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
try {
  for (const { id, route, width, height } of screens) {
    const page = await browser.newPage({
      viewport: { width, height }, deviceScaleFactor: 1, locale: "en-US",
      timezoneId: "America/Los_Angeles", colorScheme: "light", reducedMotion: "reduce",
    });
    page.on("pageerror", (error) => errors.push(`${phase}/${id}: ${error.message}`));
    const response = await page.goto(siteUrl + route, { waitUntil: "networkidle", timeout: 60_000 });
    if (!response?.ok()) throw new Error(`${phase}/${id}: HTTP ${response?.status()}`);
    await page.locator("h1").first().waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready);
    // Dev-mode status toast is not part of the café owner UI and can change asynchronously.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.waitForTimeout(300);
    const filename = join(output, `${phase}-${id}.png`);
    const bytes = await page.screenshot({ path: filename, fullPage: false, animations: "disabled" });
    if (phase === "after") {
      const earlier = readFileSync(join(output, `before-${id}.png`));
      if (!bytes.equals(earlier)) errors.push(`${id}: before/after screenshot bytes differ`);
    }
    console.log(`${phase}: ${route} ${width}x${height} (${bytes.length} bytes)`);
    await page.close();
  }
} finally {
  await browser.close();
}
if (errors.length) throw new Error(`Redesign 16 regression:\n${errors.join("\n")}`);
