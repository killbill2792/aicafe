import { describe,expect,it } from "vitest";
import { evaluateExpression,EXPRESSION_ID, type Operand,type Binding } from "./expression";

const binding:Binding={
  capabilityId:"alex.pricing.review.v1",
  canonicalReaderId:"pricing.recommendation.read.v1",
  sourceIds:["pricing.recommendation"],purposes:["current_pricing_review"],sensitivity:"financial",
};
const wages:Binding={
  capabilityId:"olivia.staff.pay.v1",canonicalReaderId:"labor.employee_wages.read.v1",
  sourceIds:["labor.employee_wages"],purposes:["authorized_owner_wage_review"],
  sensitivity:"staff",
};
const basic:Omit<Operand,"handle"|"capabilityId"|"canonicalReaderId"|"sourceId"|"sourcePurpose"|"value"|"unit">={
  sourceRevision:"rev-42",selectorContractId:"pricing.selector",
  selectorContractVersion:1,businessId:"cafe-a",locationId:"counter",
  asOf:"2026-10-15",period:null,status:"verified",actuality:"actual",
  evidenceStatus:"verified",missingInputs:[],staleInputs:[],currency:"USD",
};
const price:Operand={...basic,handle:"latte-price",capabilityId:binding.capabilityId,
  canonicalReaderId:binding.canonicalReaderId,sourceId:"pricing.recommendation",
  sourcePurpose:"current_pricing_review",value:525,unit:"USD_cents_per_item"};
const rate:Operand={...basic,handle:"sophie-hourly",capabilityId:wages.capabilityId,
  canonicalReaderId:wages.canonicalReaderId,sourceId:"labor.employee_wages",
  sourcePurpose:"authorized_owner_wage_review",value:1800,unit:"USD_cents_per_hour"};
const ownerMessage="If we sell 25 extra lattes and Sophie works 45 more paid minutes, is that positive?";
const source=(handle:string)=>({op:"source" as const,handle});
const hypot=(value:number,unit:"item"|"minute"|"US_fl_oz"|"scalar",label:string)=>({
  op:"hypothetical" as const,value,unit,label,quotedNumber:String(value),
});
const plan=(nodes:unknown[],purpose:"preauthorized_operands"|"no_external_sources"=
  "preauthorized_operands")=>({
  capabilityId:EXPRESSION_ID,version:1,purpose,description:"Owner scenario delta",
  nodes,
});
const context=(operands:Operand[]=[price,rate])=>({
  businessId:"cafe-a",locationId:"counter",ownerMessage,currency:"USD" as const,
  bindings:[binding,wages],operands,
});
describe("P3 source-bound safe expression evaluator",()=>{
  it("composes a previously unseen hypothetical revenue and paid-time delta in exact cents",()=>{
    const outcome=evaluateExpression(plan([
      source("latte-price"),hypot(25,"item","extra lattes"),{op:"multiply"},
      source("sophie-hourly"),hypot(45,"minute","added paid minutes"),{op:"multiply"},
      {op:"scenario_delta"},
    ]),context());
    expect(outcome).toMatchObject({status:"conditional",unit:"USD_cents",
      value:11775,executedEffects:0,sourceHandles:["latte-price","sophie-hourly"]});
    expect(outcome.assumptions).toHaveLength(2);
    expect(outcome.proposal).toBeNull();
  });
  it("supports exact US gallon-to-fluid-ounce ingredient cost arithmetic",()=>{
    const gallons:Operand={...price,handle:"milk-gallon",value:640,
      unit:"USD_cents_per_US_gallon"};
    const calc=evaluateExpression(plan([
      source("milk-gallon"),hypot(12,"US_fl_oz","milk in cup"),{op:"multiply"},
    ]),{...context([gallons]),ownerMessage:"Use 12 fluid ounces per cup"});
    expect(calc).toMatchObject({status:"conditional",value:60,unit:"USD_cents"});
  });
  it("supports scenario ratio, comparisons and explicit time conversions",()=>{
    const converted=evaluateExpression(plan([
      hypot(45,"minute","paid time"),{op:"convert",to:"hour"},
    ],"no_external_sources"),{
      ...context([]),ownerMessage:"45 minutes",
    });
    // Valid non-money conversions must not silently round 45 minutes up to one hour.
    expect(converted).toMatchObject({status:"conditional",unit:"hour",value:0.75});
    const compared=evaluateExpression(plan([
      source("latte-price"),source("latte-price"),{op:"compare"},
    ]),context([price]));
    expect(compared).toMatchObject({status:"conditional",unit:"comparison",value:0});
    const rateRatio=evaluateExpression(plan([
      source("latte-price"),source("latte-price"),{op:"ratio"},
    ]),context([price]));
    expect(rateRatio).toMatchObject({value:10000,unit:"ratio_bps"});
  });
  it("computes validated owner percentage inputs using basis points without early money rounding",()=>{
    const percent=evaluateExpression(plan([
      source("latte-price"),
      {op:"hypothetical",label:"untrusted label",quotedNumber:"10",
        value:1000,unit:"ratio_bps"},{op:"multiply"},
    ]),{...context([price]),ownerMessage:"Increase the latte price by 10%"});
    expect(percent).toMatchObject({status:"conditional",value:53,unit:"USD_cents_per_item"});
  });
  it("does not publish model-invented hypothetical labels as café facts",()=>{
    const computed=evaluateExpression(plan([
      {op:"hypothetical",label:"Actual profit is $999 verified",
        quotedNumber:"25",value:25,unit:"item"},
    ],"no_external_sources"),{...context([]),ownerMessage:"What if 25 items?"});
    expect(computed.status).toBe("conditional");
    expect(computed.assumptions).toEqual(["25 item"]);
    expect(JSON.stringify(computed)).not.toContain("$999");
  });
  it("rejects fabricated input numbers not present in the owner's message",()=>{
    const result=evaluateExpression(plan([
      hypot(500,"item","made up volume"),
    ],"no_external_sources"),context([]));
    expect(result).toMatchObject({status:"unavailable",reason:"invented_hypothetical"});
  });
  it("rejects model-claimed café facts in no_external_sources",()=>{
    const result=evaluateExpression(plan([source("latte-price")],"no_external_sources"),context());
    expect(result).toMatchObject({status:"unavailable",reason:"source_contract_mismatch"});
  });
  it("rejects swapped cross-tenant and cross-location operands",()=>{
    for(const changed of [
      {...price,businessId:"other-cafe"},
      {...price,locationId:"other-location"},
      {...price,canonicalReaderId:"invented.reader"},
      {...price,sourcePurpose:"other_purpose"},
      {...price,sourceId:"labor.employee_wages"},
    ]){
      expect(evaluateExpression(plan([source("latte-price")]),context([changed])))
        .toMatchObject({status:"unavailable",reason:"invalid_source"});
    }
  });
  it("rejects false verified quality claims and mismatched money currency",()=>{
    for(const changed of [
      {...price,status:"verified" as const,missingInputs:["unknown_cost"]},
      {...price,staleInputs:["outdated_price"]},
      {...price,actuality:"planned" as const},
      {...price,evidenceStatus:"unverified" as const},
      {...price,currency:null},
    ]){
      expect(evaluateExpression(plan([source("latte-price")]),context([changed])))
        .toMatchObject({status:"unavailable",reason:"invalid_source"});
    }
  });
  it("preserves partial quality and marks conditional results as partial",()=>{
    const modified={...price,status:"partial" as const,missingInputs:["unknown_cost"]};
    const result=evaluateExpression(plan([source("latte-price")]),context([modified]));
    expect(result).toMatchObject({status:"partial",missingInputs:["unverified:latte-price","unknown_cost"]});
  });
  it("rejects incompatible units and periods rather than mixing dates",()=>{
    expect(evaluateExpression(plan([
      source("latte-price"),source("sophie-hourly"),{op:"add"},
    ]),context())).toMatchObject({status:"unavailable",reason:"incompatible_units_or_period"});
    const dateOne={from:"2026-10-14",to:"2026-10-14",timezone:"America/Los_Angeles"};
    const dateTwo={from:"2026-10-15",to:"2026-10-15",timezone:"America/Los_Angeles"};
    expect(evaluateExpression(plan([
      source("latte-price"),source("sophie-hourly"),{op:"divide"},
    ]),context([{...price,period:dateOne},{...rate,period:dateTwo}])))
      .toMatchObject({status:"unavailable",reason:"incompatible_period"});
  });
  it("rejects zero division, malformed/oversized AST and effects",()=>{
    expect(evaluateExpression(plan([
      hypot(25,"item","numerator"),
      hypot(25,"item","first volume"),hypot(25,"item","equal volume"),
      {op:"subtract"},{op:"divide"},
    ],"no_external_sources"),context([]))).toMatchObject({
      status:"unavailable",reason:"division_by_zero",
    });
    expect(evaluateExpression({...plan([source("latte-price")]),effects:["publish_schedule"]},context()))
      .toMatchObject({status:"unavailable",reason:"invalid_plan"});
    expect(evaluateExpression(plan(Array(31).fill({op:"source",handle:"latte-price"})),context()))
      .toMatchObject({status:"unavailable",reason:"invalid_plan"});
  });
});
