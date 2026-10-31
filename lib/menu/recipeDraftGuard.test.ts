import {describe,it,expect} from "vitest";
import {hasPendingRecipeMeasurements} from "./recipeDraftGuard";

describe("recipe size-switch draft guard",()=>{
 it("blocks switching sizes when ONLY a saved milk's density was edited",()=>{
  // Saved 103 g / canonical 100 ml; owner changes 1.03 to 1.08 g/ml.
  // Quantity/unit/order have not changed, but saving would change base quantity.
  expect(hasPendingRecipeMeasurements({"12oz:milk":"1.08"},{})).toBe(true);
  // Switching to 16oz and clearing on its successful save must not silently
  // drop this 12oz draft. Only a successful save of the edited size clears it.
  expect(hasPendingRecipeMeasurements({},{})).toBe(false);
 });
 it("blocks a pending shot/pump calibration even when amount is unchanged",()=>{
  expect(hasPendingRecipeMeasurements({},{"milk:pump":"7.4"})).toBe(true);
  expect(hasPendingRecipeMeasurements({"12oz:milk":"1.03"},{"milk:pump":"7.4"})).toBe(true);
 });
 it("still treats a blank/invalid density draft as unsaved until corrected or canceled",()=>{
  expect(hasPendingRecipeMeasurements({"12oz:milk":""},{})).toBe(true);
  expect(hasPendingRecipeMeasurements({"12oz:milk":"not-a-number"},{})).toBe(true);
 });
});
