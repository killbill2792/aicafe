import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { themes } from "@/app/themes";

const luminance = (hex: string) => { const [r,g,b] = hex.slice(1).match(/../g)!.map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b; };
const contrast = (a: string,b: string) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);

describe("cost recovery progress track", () => {
  it("renders the unfilled remainder on a distinct semantic line color", () => {
    const code = readFileSync("components/money/CostRecoveryView.tsx", "utf8");
    expect(code).toContain('className="h-2.5 rounded-full bg-line"');
    expect(code).toContain('className="h-2.5 rounded-full bg-good"');
    expect(code).not.toContain('className="h-2.5 rounded-full bg-surface"');
  });
  it("keeps line track distinguishable from the enclosing card for all modes", () => {
    for (const theme of themes) for (const mode of ["light","dark"] as const) {
      expect(contrast(theme[mode].line,theme[mode].surface), `${theme.id}/${mode}`).toBeGreaterThanOrEqual(1.3);
    }
  });
});
