import {describe,it,expect} from "vitest";
import {swapCostPerSize,DEFAULT_TARGET_PRODUCT_COST_PERCENT} from "@/lib/metrics/core/modifierPricing";
import {isMilkSwapQuestion,requestedMilkSizes,requestedMilkTarget,milkFactToken,milkSwapFromFacts} from "./milkSwap";
import type {SavedFact} from "./inject";
const fact=(fact_key:string,value_json:unknown):SavedFact=>({
 fact_key,value_json,created_at:"2026-10-28T00:00:00Z",unit:null,period_scope:null
});
const sizes=[{id:"16oz",label:"16 oz"}];
describe("milk fact identities",()=>{
 it("normalizes saved serving-cost keys",()=>{
  expect(milkFactToken("almond milk")).toBe("almond");
  expect(milkFactToken("soy milk")).toBe("soy");
  expect(milkFactToken("coconut milk")).toBe("coconut");
  expect(milkFactToken("leche de almendra")).toBe("almendra");
 });
});
describe("shared modifier explanation is executable math",()=>{
 it.each([[40,90],[25,40],[70,70],[100,20],[30,131]] as const)(
  "recomputes the shown divisor and 5-cent ceil for %s → %s cents",(base,target)=>{
   const saved=[fact("milk_base_type","whole milk"),fact("milk_ml:16oz",160),
    fact("milk_base_serving_cost_cents:16oz",base),
    fact("milk_oat_serving_cost_cents:16oz",target)];
   const result=milkSwapFromFacts(sizes,saved,[],"oat milk");
   const line=result.explain.find(item=>item.label==="Suggested upcharge");
   expect(line).toBeDefined();
   const delta=line!.inputs.find(input=>input.name==="costDeltaCents")!.value;
   const pct=line!.inputs.find(input=>input.name==="targetProductCostPercent")!.value;
   const step=line!.inputs.find(input=>input.name==="roundingStepCents")!.value;
   expect(delta.kind).toBe("money");expect(pct.kind).toBe("percent");expect(step.kind).toBe("money");
   if(delta.kind!=="money"||pct.kind!=="percent"||step.kind!=="money")throw new Error("unexpected explanation inputs");
   expect(pct.bps).toBe(3000);
   expect(step.cents).toBe(5);
   const shown=Math.ceil(Math.max(0,delta.cents)/(pct.bps/10000)/step.cents)*step.cents;
   expect(shown).toBe(result.rows[0].suggestedUpchargeCents);
   expect(line?.inputs.map(input=>input.name)).not.toContain("remainingShare");
  });
});
describe("milk swap shared-module screen/chat parity",()=>{
 it.each(["almond","soy","coconut"])("any target %s uses shared B calculation and unique fact key",target=>{
  const milk=target+" milk";
  const saved=[fact("milk_base_type","whole milk"),fact("milk_ml:16oz",160),
    fact("milk_base_serving_cost_cents:16oz",40),
    fact("milk_"+milkFactToken(milk)+"_serving_cost_cents:16oz",90)];
  const chat=milkSwapFromFacts(sizes,saved,[],milk);
  const screen=swapCostPerSize(sizes,"whole milk",milk,
    {"16oz":{ml:160,basis:"owner_provided"}},
    {"whole milk":{costPerMlMicros:250000,basis:"owner_provided"},
      [milk]:{costPerMlMicros:562500,basis:"owner_provided"}}).sizes[0];
  expect(chat.targetMilk).toBe(milk);
  expect(chat.missing).toEqual([]);
  expect(chat.rows[0].suggestedUpchargeCents).toBe(screen.suggestedUpchargeCents);
 });
 it("never assumes oat for an unnamed swap",()=>{
  const answer=milkSwapFromFacts(sizes,[fact("milk_base_type","whole milk")],[]);
  expect(answer.targetMilk).toBeNull();
  expect(answer.missing).toContain("milk_target_type");
  expect(answer.missing.some(key=>key.startsWith("milk_oat_"))).toBe(false);
 });
 it("reuses costs saved under the former escaped-regex token without another card",()=>{
  const saved=[fact("milk_base_type","whole milk"),fact("milk_ml:16oz",160),
   fact("milk_base_serving_cost_cents:16oz",40),
   fact("milk_almond_milk_serving_cost_cents:16oz",90)];
  const answer=milkSwapFromFacts(sizes,saved,[],"almond milk");
  expect(answer.missing).toEqual([]);
  expect(answer.rows[0].targetServingCents).toBe(90);
 });
 it("missing almond cost asks for almond, never oat",()=>{
  const value=milkSwapFromFacts(sizes,[fact("milk_base_type","whole milk")],[],"almond milk");
  expect(value.missing).toContain("milk_almond_serving_cost_cents:16oz");
  expect(value.missing).not.toContain("milk_oat_serving_cost_cents:16oz");
 });
 it("selects a menu alternative by name, without inventing an option",()=>{
  const rows=[{source:"canonical_data",period:null,missing:[],rows:[
    {name:"Macadamia Cream",category:"alternative milk"},
    {name:"Whole milk",category:"dairy milk"}
  ]}];
  expect(requestedMilkTarget("Swap milk to Macadamia Cream",rows)).toBe("Macadamia Cream");
  expect(requestedMilkTarget("Change to alternative milk",rows)).toBe("Macadamia Cream");
  expect(requestedMilkTarget("Switch to almond milk",[])).toBe("almond milk");
  expect(requestedMilkTarget("Switch to soy milk",[])).toBe("soy milk");
  expect(requestedMilkTarget("Switch to coconut milk",[])).toBe("coconut milk");
  expect(requestedMilkTarget("Swap the milk",[])).toBeNull();
  expect(isMilkSwapQuestion("Switch to soy instead")).toBe(true);
  expect(isMilkSwapQuestion("Switch to Macadamia Cream",rows)).toBe(true);
  expect(isMilkSwapQuestion("Switch to a latte",rows)).toBe(false);
 });
 it("owner serving costs match B's exact recommended upcharge",()=>{
  const saved=[fact("milk_base_type","whole milk"),fact("milk_ml:16oz",160),
   fact("milk_base_serving_cost_cents:16oz",40),
   fact("milk_oat_serving_cost_cents:16oz",90)];
  const answer=milkSwapFromFacts(sizes,saved,[],"oat milk");
  expect(answer.missing).toEqual([]);
  const screen=swapCostPerSize(sizes,"whole milk","oat milk",
   {"16oz":{ml:160,basis:"owner_provided"}},
   {"whole milk":{costPerMlMicros:250000,basis:"owner_provided"},
    "oat milk":{costPerMlMicros:562500,basis:"owner_provided"}},
   DEFAULT_TARGET_PRODUCT_COST_PERCENT).sizes[0];
  expect(answer.rows[0]).toMatchObject({volumeMl:160,baseServingCents:40,
   oatServingCents:90,suggestedUpchargeCents:screen.suggestedUpchargeCents,
   additionalCostCents:screen.costDeltaCents});
  expect(answer.explain).toHaveLength(2);
 });
 it("recorded per-ml cost uses the existing shared ingredient engine",()=>{
  const answer=milkSwapFromFacts(sizes,[fact("milk_base_type","whole milk"),fact("milk_ml:16oz",160)],[
   {source:"ingredient_prices",period:null,missing:[],items:[
     {name:"whole milk",baseUnit:"ml",costPerBaseUnitMicros:250000},
     {name:"oat milk",baseUnit:"ml",costPerBaseUnitMicros:500000}
   ]}
  ],"oat milk");
  expect(answer.rows[0].baseServingCents).toBe(40);
  expect(answer.rows[0].oatServingCents).toBe(80);
  expect(answer.missing).toEqual([]);
  const screen=swapCostPerSize(sizes,"whole milk","oat milk",
   {"16oz":{ml:160,basis:"recorded"}},
   {"whole milk":{costPerMlMicros:250000,basis:"recorded"},
    "oat milk":{costPerMlMicros:500000,basis:"recorded"}}).sizes[0];
  expect(answer.rows[0].suggestedUpchargeCents).toBe(screen.suggestedUpchargeCents);
 });
 it("reads milk volume and cost from provider-neutral canonical data rows",()=>{
  const saved=[fact("milk_base_type","whole milk")];
  const result=milkSwapFromFacts(sizes,saved,[{
    source:"canonical_data",period:null,missing:[],rows:[
     {source:"toast",data:{name:"Latte 16 oz",milk_ml:160}},
     {source:"toast",data:{name:"whole milk",baseUnit:"ml",costPerBaseUnitMicros:250000}},
     {source:"toast",data:{name:"oat milk",baseUnit:"ml",costPerBaseUnitMicros:500000}}
    ]
  }],"oat milk");
  expect(result.missing).toEqual([]);
  expect(result.rows[0]).toMatchObject({volumeMl:160,baseServingCents:40,oatServingCents:80});
 });
 it("recorded recipe volume outranks an older owner volume and matches screen",()=>{
  const answer=milkSwapFromFacts(sizes,[
   fact("milk_base_type","whole milk"),fact("milk_ml:16oz",160),
   fact("milk_base_serving_cost_cents:16oz",40),
   fact("milk_oat_serving_cost_cents:16oz",90)
  ],[{source:"canonical_data",period:null,missing:[],rows:[
   {source:"toast",data:{name:"Latte 16 oz",milk_ml:200}},
   {source:"toast",data:{name:"whole milk",baseUnit:"ml",costPerBaseUnitMicros:250000}},
   {source:"toast",data:{name:"oat milk",baseUnit:"ml",costPerBaseUnitMicros:500000}}
  ]}],"oat milk");
  const screen=swapCostPerSize(sizes,"whole milk","oat milk",
   {"16oz":{ml:200,basis:"recorded"}},
   {"whole milk":{costPerMlMicros:250000,basis:"recorded"},
    "oat milk":{costPerMlMicros:500000,basis:"recorded"}}).sizes[0];
  expect(answer.rows[0].volumeMl).toBe(200);
  expect(answer.rows[0].suggestedUpchargeCents).toBe(screen.suggestedUpchargeCents);
 });
 it("recorded milk cost outranks older owner fallback, so chat cannot hide fresh POS evidence",()=>{
  const answer=milkSwapFromFacts(sizes,[
   fact("milk_base_type","whole milk"),fact("milk_ml:16oz",160),
   fact("milk_base_serving_cost_cents:16oz",999),
   fact("milk_oat_serving_cost_cents:16oz",999)
  ],[{source:"ingredient_prices",period:null,missing:[],items:[
    {name:"whole milk",baseUnit:"ml",costPerBaseUnitMicros:250000},
    {name:"oat milk",baseUnit:"ml",costPerBaseUnitMicros:500000}
  ]}],"oat milk");
  expect(answer.rows[0]).toMatchObject({baseServingCents:40,oatServingCents:80});
 });
 it("recorded milk prices plus missing recipe volume asks only for ml",()=>{
  const result=milkSwapFromFacts(sizes,[fact("milk_base_type","whole milk")],[
    {source:"ingredient_prices",period:null,missing:[],items:[
      {name:"whole milk",baseUnit:"ml",costPerBaseUnitMicros:250000},
      {name:"oat milk",baseUnit:"ml",costPerBaseUnitMicros:500000}
    ]}
  ],"oat milk");
  expect(result.missing).toEqual(["milk_ml:16oz"]);
  expect(result.rows[0].suggestedUpchargeCents).toBeNull();
 });
 it("missing cost or ml is never silently assumed zero",()=>{
  const answer=milkSwapFromFacts(sizes,[fact("milk_base_type","whole milk")],[],"oat milk");
  expect(answer.missing).toContain("milk_ml:16oz");
  expect(answer.missing).toContain("milk_oat_serving_cost_cents:16oz");
  expect(answer.rows[0].suggestedUpchargeCents).toBeNull();
 });
 it("recognizes size-specific swaps in supported languages",()=>{
  expect(isMilkSwapQuestion("Switch the 16 oz latte to oat milk and suggest an upcharge")).toBe(true);
  expect(isMilkSwapQuestion("cambiar 16 onzas a leche de avena con recargo")).toBe(true);
  expect(isMilkSwapQuestion("تبديل حليب الشوفان 16 oz وزيادة السعر")).toBe(true);
  expect(requestedMilkSizes("16 oz and 12 oz")).toEqual([{id:"16oz",label:"16 oz"},{id:"12oz",label:"12 oz"}]);
  expect(requestedMilkSizes("١٦ أونصة")).toEqual([{id:"16oz",label:"16 oz"}]);
 });
});
