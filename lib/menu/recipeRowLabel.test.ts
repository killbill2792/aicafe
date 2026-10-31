import {describe,it,expect} from "vitest";
import {recipeRowDisplayName} from "./recipeRowLabel";
const ingredients=[{id:"whole",name:"Whole milk"},{id:"oat",name:"Oat milk"},{id:"almond",name:"Almond milk"}];
describe("size-specific replacement names in mobile and desktop recipe rows",()=>{
 it("shows the pending Oat milk identity before Save, not original Whole milk",()=>{
  const draft={"12oz:whole":"oat"};
  expect(recipeRowDisplayName("12oz","whole","Whole milk",draft,ingredients)).toBe("Oat milk");
  expect(recipeRowDisplayName("16oz","whole","Whole milk",draft,ingredients)).toBe("Whole milk");
 });
 it("returns the original label on undo and fails visibly conservative for stale ingredient IDs",()=>{
  expect(recipeRowDisplayName("12oz","whole","Whole milk",{},ingredients)).toBe("Whole milk");
  expect(recipeRowDisplayName("12oz","whole","Whole milk",{"12oz:whole":"unknown"},ingredients)).toBe("Whole milk");
 });
});
