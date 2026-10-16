import { describe,expect,it } from "vitest";
import { evaluateExpression,EXPRESSION_ID } from "./scenarioExpression";

const scope=(ownerMessage:string)=>({
  businessId:"cafe-a",locationId:null,ownerMessage,currency:"USD" as const,
  bindings:[],operands:[],
});
const plan=(quotedNumber:string,value:number,unit:string)=>({
  capabilityId:EXPRESSION_ID,version:1,purpose:"no_external_sources",
  description:"Owner-stated conditional quantity",nodes:[{
    op:"hypothetical",label:"untrusted model label",quotedNumber,value,unit,
  }],
});
describe("canonical pure scenario arithmetic and locale-safe owner attribution",()=>{
  it("uses Arabic-Indic digits only when the owner stated them",()=>{
    expect(evaluateExpression(plan("٢٥",25,"item"),scope("ماذا لو بعنا ٢٥ كوبًا؟")))
      .toMatchObject({status:"conditional",value:25,unit:"item",executedEffects:0});
    expect(evaluateExpression(plan("٢٥",25,"item"),scope("ماذا لو بعنا ٣٥ كوبًا؟")))
      .toMatchObject({status:"unavailable",reason:"invented_hypothetical"});
  });
  it("accepts Spanish comma decimals while retaining cents",()=>{
    expect(evaluateExpression(plan("12,5",1250,"USD_cents_per_item"),
      scope("¿Y si el precio por bebida es 12,5 dólares?")))
      .toMatchObject({status:"conditional",value:1250,unit:"USD_cents_per_item"});
  });
  it("normalizes Arabic decimal separators but rejects ambiguous groupings",()=>{
    expect(evaluateExpression(plan("١٢٫٥",1250,"USD_cents_per_item"),
      scope("سعر الحليب ١٢٫٥ دولار")))
      .toMatchObject({status:"conditional",value:1250});
    expect(evaluateExpression(plan("1,000",100000,"USD_cents_per_item"),
      scope("¿Y si 1,000?"))).toMatchObject({
        status:"unavailable",reason:"invented_hypothetical",
      });
  });
});
