import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const detail = readFileSync(resolve(here, "../../app/[locale]/more/alerts/[id]/page.tsx"), "utf8");

describe("alert button to persisted status", () => {
  it("Done resolves without changing the status enum", () => {
    expect(detail).toContain('markAlertStatus.bind(null, alert.id, "resolved")');
    for (const locale of ["en","es","ar"]) {
      const messages = JSON.parse(readFileSync(resolve(here, `../../messages/${locale}.json`),"utf8")).Alerts;
      expect(messages.markReviewed).toBeTruthy();
    }
  });
  it("Not an issue dismisses without changing the status enum", () => {
    expect(detail).toContain('markAlertStatus.bind(null, alert.id, "dismissed")');
    for (const locale of ["en","es","ar"]) {
      const messages = JSON.parse(readFileSync(resolve(here, `../../messages/${locale}.json`),"utf8")).Alerts;
      expect(messages.dismiss).toBeTruthy();
    }
  });
});