import { describe, expect, it } from "vitest";
import { hourInputToMinutes, minutesToHourInput } from "./hourInput";

describe("Owner hour limits use human hours and canonical integer minutes", () => {
  it("stores whole and fractional hours as minutes", () => {
    expect(hourInputToMinutes("20:00",10080)).toBe(1200);
    expect(hourInputToMinutes("1:30",1440)).toBe(90);
    expect(hourInputToMinutes("0:00",1440,true)).toBe(0);
    expect(hourInputToMinutes("",10080)).toBe(null);
  });
  it("renders saved minutes in human hours without losing the original minute", () => {
    for(const minutes of [0,15,45,50,60,90,1200,10080]){
      expect(hourInputToMinutes(minutesToHourInput(minutes),10080)).toBe(minutes);
    }
  });
  it("rejects invalid, negative, over-limit and non-finite entries", () => {
    for (const value of ["-1","NaN","Infinity","99x","1e3","", "1.2.3","0.001","24.001","1:60"]) {
      expect(() => hourInputToMinutes(value,1440,true)).toThrow();
    }
    expect(() => hourInputToMinutes("25:00",1440)).toThrow();
    expect(() => hourInputToMinutes("169:00",10080)).toThrow();
  });
});
