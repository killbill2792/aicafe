import { describe, expect, it } from "vitest";
import { profitTone, profitToneTextClass } from "./profitTone";

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
