import { chromium } from "playwright";
import { PNG } from "pngjs";
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
      const b = PNG.sync.read(earlier), a = PNG.sync.read(bytes);
      if (b.width !== a.width || b.height !== a.height) {
        errors.push(`${id}: dimensions changed: ${b.width}x${b.height} -> ${a.width}x${a.height}`);
      } else {
        let count = 0, large = 0, maxChannelDelta = 0;
        let minX = a.width, minY = a.height, maxX = -1, maxY = -1;
        for (let y = 0; y < a.height; y++) {
          for (let x = 0; x < a.width; x++) {
            const index = (y * a.width + x) * 4;
            const deltas = [0, 1, 2, 3].map((c) => Math.abs(a.data[index + c] - b.data[index + c]));
            const max = Math.max(...deltas);
            if (max) {
              count++;
              maxChannelDelta = Math.max(maxChannelDelta, max);
              if (max > 1) large++;
              minX = Math.min(x, minX); minY = Math.min(y, minY);
              maxX = Math.max(x, maxX); maxY = Math.max(y, maxY);
            }
          }
        }
        console.log(`${id}: pixel diff count ${count}/${a.width * a.height}; strong ${large}; max channel ${maxChannelDelta}; bbox ${minX},${minY}-${maxX},${maxY}`);
        if (large) errors.push(`${id}: ${large} before/after pixels differ by more than one channel value`);
      }
    }
    console.log(`${phase}: ${route} ${width}x${height} (${bytes.length} bytes)`);
    await page.close();
  }
} finally {
  await browser.close();
}
if (errors.length) throw new Error(`Redesign 16 regression:\n${errors.join("\n")}`);
