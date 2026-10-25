import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { negligibleScreenshotDrift } from "./redesign16-pixel-diff.mjs";
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
      if (!bytes.equals(earlier)) {
        // Two isolated Chromium processes may render a few subpixel edges one
        // color-channel level apart. Compare decoded pixels, with a tightly
        // bounded tolerance, rather than treating PNG byte drift as a UI bug.
        const diff = await page.evaluate(async ({ expected, actual }) => {
          async function raster(base64) {
            const img = new Image();
            img.src = `data:image/png;base64,${base64}`;
            await img.decode();
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("Canvas is unavailable");
            context.drawImage(img, 0, 0);
            return {
              width: canvas.width, height: canvas.height,
              pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
            };
          }
          const before = await raster(expected), after = await raster(actual);
          if (before.width !== after.width || before.height !== after.height) {
            return { sameDimensions: false, changedPixels: -1, maxChannelDelta: 255 };
          }
          let changedPixels = 0, maxChannelDelta = 0;
          for (let i = 0; i < before.pixels.length; i += 4) {
            let changed = false;
            for (let channel = 0; channel < 4; channel++) {
              const difference = Math.abs(before.pixels[i + channel] - after.pixels[i + channel]);
              maxChannelDelta = Math.max(maxChannelDelta, difference);
              changed ||= difference !== 0;
            }
            if (changed) changedPixels++;
          }
          return { sameDimensions: true, changedPixels, maxChannelDelta };
        }, { expected: earlier.toString("base64"), actual: bytes.toString("base64") });
        if (!negligibleScreenshotDrift(diff)) {
          errors.push(`${id}: screenshot pixel regression: ${JSON.stringify(diff)}`);
        } else {
          console.log(`${id}: tolerated negligible raster drift: ${JSON.stringify(diff)}`);
        }
      }
    }
    console.log(`${phase}: ${route} ${width}x${height} (${bytes.length} bytes)`);
    await page.close();
  }
} finally {
  await browser.close();
}
if (errors.length) throw new Error(`Redesign 16 regression:\n${errors.join("\n")}`);
