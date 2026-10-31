import {describe,it,expect} from "vitest";
import {suggestedRecipeMeasure} from "./suggestedRecipeMeasures";
describe("optional suggested ingredient measurements",()=>{
 it("uses manufacturer-sized syrup pumps as suggestions, not universal conversions",()=>{
  expect(suggestedRecipeMeasure("Vanilla syrup","ml","pump")?.baseUnitsPerUnit).toBeCloseTo(7.393375);
  expect(suggestedRecipeMeasure("Whole milk","ml","pump")).toBeNull();
 });
 it("distinguishes a poured liquid shot from a dry espresso dose",()=>{
  expect(suggestedRecipeMeasure("Milk","ml","shot")?.baseUnitsPerUnit).toBeCloseTo(44.360294);
  expect(suggestedRecipeMeasure("Espresso beans","g","shot")?.baseUnitsPerUnit).toBe(18);
  expect(suggestedRecipeMeasure("Sugar","g","shot")).toBeNull();
 });
});