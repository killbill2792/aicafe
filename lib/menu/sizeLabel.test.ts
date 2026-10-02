import { describe, expect, it } from "vitest";
import { isAmbiguousNumericSizeLabel, resolveSizeLabel } from "./sizeLabel";

describe("isAmbiguousNumericSizeLabel", () => {
  it("flags a bare integer", () => {
    expect(isAmbiguousNumericSizeLabel("16")).toBe(true);
  });

  it("flags a bare decimal", () => {
    expect(isAmbiguousNumericSizeLabel("12.5")).toBe(true);
  });

  it("flags a bare number with surrounding whitespace", () => {
    expect(isAmbiguousNumericSizeLabel("  16  ")).toBe(true);
  });

  it("does not flag a number already paired with a unit", () => {
    expect(isAmbiguousNumericSizeLabel("16 oz")).toBe(false);
    expect(isAmbiguousNumericSizeLabel("350 ml")).toBe(false);
    expect(isAmbiguousNumericSizeLabel("150g")).toBe(false);
  });

  it("does not flag named sizes", () => {
    expect(isAmbiguousNumericSizeLabel("Small")).toBe(false);
    expect(isAmbiguousNumericSizeLabel("Medium")).toBe(false);
    expect(isAmbiguousNumericSizeLabel("1 piece")).toBe(false);
  });

  it("does not flag an empty or blank size (optional field)", () => {
    expect(isAmbiguousNumericSizeLabel("")).toBe(false);
    expect(isAmbiguousNumericSizeLabel("   ")).toBe(false);
  });
});

describe("resolveSizeLabel", () => {
  it("appends the chosen unit", () => {
    expect(resolveSizeLabel("16", "oz")).toBe("16 oz");
    expect(resolveSizeLabel("16", "ml")).toBe("16 ml");
    expect(resolveSizeLabel("16", "g")).toBe("16 g");
    expect(resolveSizeLabel("16", "each")).toBe("16 each");
  });

  it("keeps the bare number as the label when the owner says so", () => {
    expect(resolveSizeLabel("16", "keep")).toBe("16");
  });

  it("trims the raw value first", () => {
    expect(resolveSizeLabel("  16  ", "oz")).toBe("16 oz");
  });
});
