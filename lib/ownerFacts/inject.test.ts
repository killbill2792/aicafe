import {describe,it,expect} from "vitest";
import {injectSavedOwnerInputs,formatSavedOwnerFacts,itemCostFactKey} from "./inject";
import {ownerInputsSchema} from "@/lib/ai/agent/tools/ownerInputs";
const facts=[{fact_key:"monthly_payroll_cents",value_json:1300000,created_at:"2026-10-28T12:00:00Z",unit:"cents",period_scope:"month"}];
describe("owner facts injection",()=>{
 it("latte cost is injected only for the same item, never a sandwich or a global legacy key",()=>{
  const template=facts[0];
  const saved=[{...template,fact_key:"unit_cost_cents",value_json:99},
   {...template,fact_key:"unit_cost_cents:item:latte-id",value_json:125}];
  const latte=injectSavedOwnerInputs({itemId:"latte-id",ownerInputs:null},saved) as {ownerInputs:{unitCostCents:number|null}};
  const sandwich=injectSavedOwnerInputs({itemId:"sandwich-id",ownerInputs:null},saved) as {ownerInputs:{unitCostCents:number|null}};
  expect(latte.ownerInputs.unitCostCents).toBe(125);
  expect(sandwich.ownerInputs.unitCostCents).toBeNull();
  expect(itemCostFactKey("latte-id")).toBe("unit_cost_cents:item:latte-id");
 });
 it("populates strict existing ownerInputs without overwriting explicit values",()=>{
  const next=injectSavedOwnerInputs({period:"month",ownerInputs:null},facts) as {ownerInputs:unknown};
  const parsed=ownerInputsSchema.parse(next.ownerInputs);
  expect(parsed.laborCents).toBe(1300000);
  expect(parsed.laborPeriod).toEqual({unit:"month"});
  const explicit=injectSavedOwnerInputs({ownerInputs:{...parsed,laborCents:2000000}},facts) as {ownerInputs:{laborCents:number}};
  expect(explicit.ownerInputs.laborCents).toBe(2000000);
 });
 it("fills omitted optional ownerInputs only when tool schema accepts them",()=>{
   const next=injectSavedOwnerInputs({period:"month"},facts,true) as {ownerInputs:unknown};
   expect(ownerInputsSchema.parse(next.ownerInputs).laborCents).toBe(1300000);
   expect(injectSavedOwnerInputs({period:"month"},facts,false)).toEqual({period:"month"});
 });
 it("never injects a field for tools without ownerInputs",()=>{expect(injectSavedOwnerInputs({query:"latte"},facts)).toEqual({query:"latte"});});
 it("does not smuggle a total monthly bill into other overhead",()=>{
  const bills=[{...facts[0],fact_key:"monthly_bills_cents",value_json:900000}];
  const next=injectSavedOwnerInputs({ownerInputs:null},bills) as {ownerInputs:unknown};
  expect(ownerInputsSchema.parse(next.ownerInputs).otherOverheadCents).toBeNull();
 });
 it("never drops a saved answer from model context after forty facts",()=>{
  const many=Array.from({length:205},(_,i)=>({
   ...facts[0],fact_key:"answer_"+i,value_json:i
  }));
  expect(formatSavedOwnerFacts(many)).toContain("answer_204=204");
 });
 it("separates saved facts from approved memory",()=>{expect(formatSavedOwnerFacts(facts)).toContain("Saved by owner: monthly_payroll_cents=1300000");});
});
