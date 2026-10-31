import {describe,expect,it} from "vitest";
import {selectedActiveIngredient} from "./stockEntrySelection";
import {packBaseQuantity} from "@/lib/calc/recipeUnits";

type Item={id:string;name:string;baseUnit:"each"|"ml"|"g";archivedAt:string|null};
const both:Item[]=[
 {id:"A",name:"A cups",baseUnit:"each",archivedAt:null},
 {id:"B",name:"B cups",baseUnit:"each",archivedAt:null},
];

describe("stock entry selection across an archive-triggered refresh",()=>{
 it("never redirects a stale A ID to the newly visible B option or submits A",()=>{
  expect(selectedActiveIngredient(both,"A")?.id).toBe("A");
  const refreshed=both.map(i=>i.id==="A"?{...i,archivedAt:"2026-10-31T12:00:00Z"}:i);
  const stillSelected="A";
  // Even though HTML would otherwise visually fall through to B, the
  // explicit placeholder must represent the invalid selection, not B.
  expect(selectedActiveIngredient(refreshed,stillSelected)).toBeNull();
  const chosen=selectedActiveIngredient(refreshed,stillSelected);
  expect(chosen!==null&&packBaseQuantity(1,"each",chosen.baseUnit)!==null).toBe(false);
  // Only an owner selection change to B restores save eligibility.
  expect(selectedActiveIngredient(refreshed,"B")?.id).toBe("B");
  expect(packBaseQuantity(1,"each",selectedActiveIngredient(refreshed,"B")!.baseUnit)).toBe(1);
 });
 it("fails closed for missing/foreign IDs and when every item is archived",()=>{
  expect(selectedActiveIngredient(both,"foreign")).toBeNull();
  expect(selectedActiveIngredient(both,"")).toBeNull();
  const archived=both.map(i=>({...i,archivedAt:"2026-10-31T12:00:00Z"}));
  expect(selectedActiveIngredient(archived,"A")).toBeNull();
  expect(selectedActiveIngredient(archived,"B")).toBeNull();
 });
 it("retains access to archived records for historical reports without allowing new entry",()=>{
  const archived={...both[0],archivedAt:"2026-10-31T12:00:00Z"};
  expect(archived.name).toBe("A cups"); // preserved historical identity
  expect(selectedActiveIngredient([archived,both[1]],archived.id)).toBeNull();
 });
});
