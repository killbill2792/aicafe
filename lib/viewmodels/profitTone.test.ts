import { describe, expect, it } from "vitest";
import { flowBarWidthPct, profitTone, profitToneBgClass, profitToneTextClass } from "./profitTone";

describe("profitTone", () => {
  it("is good for any positive amount", () => {
    expect(profitTone(1)).toBe("good");
    expect(profitTone(500_000)).toBe("good");
  });

  it("is warn for any negative amount", () => {
    expect(profitTone(-1)).toBe("warn");
    expect(profitTone(-500_000)).toBe("warn");
  });

  it("is neutral for exactly zero", () => {
    expect(profitTone(0)).toBe("neutral");
  });
});

describe("profitToneTextClass", () => {
  it("maps each tone to its text color class", () => {
    expect(profitToneTextClass("good")).toBe("text-good");
    expect(profitToneTextClass("warn")).toBe("text-warn");
    expect(profitToneTextClass("neutral")).toBe("text-ink");
  });
});

describe("profitToneBgClass", () => {
  it("maps each tone to a full-bleed background class, zero staying a calm neutral rather than green", () => {
    expect(profitToneBgClass("good")).toBe("bg-good");
    expect(profitToneBgClass("warn")).toBe("bg-warn");
    expect(profitToneBgClass("neutral")).toBe("bg-ink");
  });
});

describe("flowBarWidthPct", () => {
  it("is the same for a profit and an equal-magnitude loss — sign never affects width", () => {
    expect(flowBarWidthPct(2_500, 10_000)).toBe(25);
    expect(flowBarWidthPct(-2_500, 10_000)).toBe(25);
  });

  it("a negative value still produces a visible (non-zero) bar, not a clamped-to-0 one", () => {
    const width = flowBarWidthPct(-3_000, 10_000);
    expect(width).toBeGreaterThan(0);
    expect(width).toBe(30);
  });

  it("clamps to 100 when the magnitude exceeds sales (e.g. a loss bigger than total sales)", () => {
    expect(flowBarWidthPct(-15_000, 10_000)).toBe(100);
  });

  it("is 0 when there are no sales to measure against", () => {
    expect(flowBarWidthPct(5_000, 0)).toBe(0);
    expect(flowBarWidthPct(-5_000, 0)).toBe(0);
  });
});
