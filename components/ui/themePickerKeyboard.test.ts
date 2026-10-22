import { describe, expect, it } from "vitest";
import { themeArrowDelta } from "./themePickerKeyboard";
describe("theme-picker keyboard order", () => {
  it("moves to the corresponding visible neighbor in LTR",()=>{
    expect(themeArrowDelta("ArrowRight","ltr")).toBe(1);
    expect(themeArrowDelta("ArrowLeft","ltr")).toBe(-1);
  });
  it("reverses horizontal arrows for Arabic RTL",()=>{
    expect(themeArrowDelta("ArrowRight","rtl")).toBe(-1);
    expect(themeArrowDelta("ArrowLeft","rtl")).toBe(1);
  });
  it("keeps vertical arrows and ignores unrelated keys",()=>{
    for(const dir of ["ltr","rtl"] as const){
      expect(themeArrowDelta("ArrowUp",dir)).toBe(-1);
      expect(themeArrowDelta("ArrowDown",dir)).toBe(1);
      expect(themeArrowDelta("Enter",dir)).toBeNull();
    }
  });
});
