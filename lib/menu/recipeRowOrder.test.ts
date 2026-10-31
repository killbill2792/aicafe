import {describe,it,expect} from "vitest";
import {insertRecipeRowAfter,moveRecipeRow} from "./recipeRowOrder";
import {evaluateRecipeCost} from "@/lib/calc";

type Line={ingredientId:string;quantity:number;displayUnit:"ml";displayQuantity:number};
const original:Line[]=[
 {ingredientId:"milk",quantity:180,displayUnit:"ml",displayQuantity:180},
 {ingredientId:"espresso",quantity:30,displayUnit:"ml",displayQuantity:30},
 {ingredientId:"syrup",quantity:10,displayUnit:"ml",displayQuantity:10},
];
const newLine=(id:string):Line=>({ingredientId:id,quantity:5,displayUnit:"ml",displayQuantity:5});
const ids=(rows:Line[])=>rows.map(r=>r.ingredientId);

describe("durable recipe order projection for one product size",()=>{
 it("inserts twice after the tapped ingredient and survives a serialized save/reload",()=>{
  const once=insertRecipeRowAfter(original,newLine("cinnamon"),"milk");
  const twice=insertRecipeRowAfter(once,newLine("water"),"cinnamon");
  const saved=twice.map((line,position)=>({...line,sort_order:position+1}));
  const reloaded=saved.sort((a,b)=>a.sort_order-b.sort_order);
  expect(ids(reloaded)).toEqual(["milk","cinnamon","water","espresso","syrup"]);
  expect(original.map(row=>row.quantity)).toEqual([180,30,10]);
 });
 it("moves, replaces and removes rows without changing other ingredients' measurements",()=>{
  const moved=moveRecipeRow(ids(original),"syrup",-1);
  const reordered=moved.map(id=>original.find(row=>row.ingredientId===id)!);
  const swapped=reordered.map(row=>row.ingredientId==="syrup"?{...row,ingredientId:"vanilla"}:row);
  const removed=swapped.filter(row=>row.ingredientId!=="espresso");
  expect(ids(removed)).toEqual(["milk","vanilla"]);
  expect(removed.map(row=>row.quantity)).toEqual([180,10]);
 });
 it("does not reorder or change a sibling size, or change canonical ingredient costs",()=>{
  const sibling=[...original];
  const moved=moveRecipeRow(ids(original),"syrup",-1);
  const reordered=moved.map(id=>original.find(row=>row.ingredientId===id)!);
  const prices={milk:200000,espresso:400000,syrup:300000};
  const cost=(rows:Line[])=>evaluateRecipeCost(rows.map(r=>({ingredientId:r.ingredientId,quantity:r.quantity})),prices);
  expect(cost(reordered)).toEqual(cost(original));
  expect(ids(sibling)).toEqual(["milk","espresso","syrup"]);
  expect(moveRecipeRow(ids(original),"espresso",-1)).toEqual(["espresso","milk","syrup"]);
 });
 it("rejects duplicate inserts and allows top insertion without changing old rows",()=>{
  expect(ids(insertRecipeRowAfter(original,newLine("milk"),"espresso"))).toEqual(ids(original));
  expect(ids(insertRecipeRowAfter(original,newLine("ice"),"top"))).toEqual(["ice",...ids(original)]);
 });
});
