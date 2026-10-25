import { describe, expect, it } from "vitest";
import { negligibleScreenshotDrift } from "../scripts/redesign16-pixel-diff.mjs";

describe("redesign 16 screenshot pixel tolerance", () => {
  it("accepts a 15-pixel one-channel-level browser raster drift", () => {
    expect(negligibleScreenshotDrift({ sameDimensions: true, changedPixels: 15, maxChannelDelta: 1 })).toBe(true);
  });
  it("rejects a changed text/color pixel even if only one pixel differs", () => {
    expect(negligibleScreenshotDrift({ sameDimensions: true, changedPixels: 1, maxChannelDelta: 2 })).toBe(false);
  });
  it("rejects layout shifts affecting more than 20 pixels", () => {
    expect(negligibleScreenshotDrift({ sameDimensions: true, changedPixels: 21, maxChannelDelta: 1 })).toBe(false);
  });
  it("rejects changed viewport dimensions and invalid measurements", () => {
    expect(negligibleScreenshotDrift({ sameDimensions: false, changedPixels: 0, maxChannelDelta: 0 })).toBe(false);
    expect(negligibleScreenshotDrift({ sameDimensions: true, changedPixels: -1, maxChannelDelta: 1 })).toBe(false);
  });
});
