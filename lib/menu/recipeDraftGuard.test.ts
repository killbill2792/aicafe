import {describe,it,expect} from "vitest";
import {hasPendingRecipeMeasurements,planRecipeSizeSwitch} from "./recipeDraftGuard";
import {toBaseUnitQuantity} from "@/lib/calc/recipeUnits";

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

/** These are the same decision branches used by the direct recipe size buttons;
 * the parent size-card URL path uses its own `recipeDirty` guard too. */
describe("density-only change, navigation and save reconciliation",()=>{
 it("keeps focus on A until the density edit is saved, then permits B",()=>{
  const originalBase=toBaseUnitQuantity("g",103,"ml",[],1.03);
  expect(originalBase).toBeCloseTo(100,9);
  const editedDensity={"size-A:milk":"1.08"};
  const unsaved=hasPendingRecipeMeasurements(editedDensity,{});
  expect(planRecipeSizeSwitch("size-A","size-B",unsaved)).toEqual({focusedSize:"size-A",blocked:true});
  // Saving the focused size A supplies its changed density to the canonical
  // recipe writer and changes A's physical amount; only success clears drafts.
  const savedBase=toBaseUnitQuantity("g",103,"ml",[],Number(editedDensity["size-A:milk"]));
  expect(savedBase).toBeCloseTo(95.37037037,6);
  expect(savedBase).not.toBe(originalBase);
  const afterSuccessfulSave=hasPendingRecipeMeasurements({},{});
  expect(planRecipeSizeSwitch("size-A","size-B",afterSuccessfulSave)).toEqual({focusedSize:"size-B",blocked:false});
  // Reloading both sizes may not rewrite B's stored quantity/cost while saving A.
  expect(toBaseUnitQuantity("ml",180,"ml")).toBe(180);
 });
 it("does not let invalid pending measurements be silently discarded",()=>{
  for(const value of ["","wrong","0"]){
   expect(planRecipeSizeSwitch("size-A","size-B",hasPendingRecipeMeasurements({"size-A:milk":value},{})).blocked).toBe(true);
  }
  expect(planRecipeSizeSwitch("size-A","size-B",hasPendingRecipeMeasurements({},{"milk:pump":"7.5"})).blocked).toBe(true);
 });
 it("keeps same-size actions available without changing the focused recipe",()=>{
  expect(planRecipeSizeSwitch("size-A","size-A",true)).toEqual({focusedSize:"size-A",blocked:false});
 });
});
