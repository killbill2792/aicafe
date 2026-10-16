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
  it("interprets explicitly quoted cents as cents, never as dollars",()=>{
    const cents={...plan("50",50,"USD_cents"),nodes:[{
      op:"hypothetical",quotedNumber:"50",value:50,unit:"USD_cents",
      label:"owner cents",quotedDenomination:"cents",
    }]};
    expect(evaluateExpression(cents,scope("Raise price by 50 cents")))
      .toMatchObject({status:"conditional",value:50,unit:"USD_cents"});
    expect(evaluateExpression(cents,scope("Raise price by 50 dollars")))
      .toMatchObject({status:"unavailable",reason:"denomination_mismatch"});
    expect(evaluateExpression(plan("50",5000,"USD_cents"),scope("Raise price by 50 cents")))
      .toMatchObject({status:"unavailable",reason:"denomination_mismatch"});
  });
  it("retains rational hours and permits percentages of nonmoney quantities",()=>{
    const hours={...plan("1.5",150,"hour"),nodes:[{
      op:"hypothetical",quotedNumber:"1.5",value:150,unit:"hour",
      label:"owner paid hours",quantityScale:"hundredth",
    }]};
    expect(evaluateExpression(hours,scope("Use 1.5 extra hours")))
      .toMatchObject({status:"conditional",value:1.5,unit:"hour"});
    const percent={...plan("40",40,"hour"),nodes:[
      {op:"hypothetical",label:"work hours",quotedNumber:"40",value:40,unit:"hour"},
      {op:"hypothetical",label:"percent reduction",quotedNumber:"10",
        value:1000,unit:"ratio_bps"},{op:"multiply"},
    ]};
    expect(evaluateExpression(percent,scope("Reduce 40 labor hours by 10%")))
      .toMatchObject({status:"conditional",value:4,unit:"hour"});
    const items={...plan("25",25,"item"),nodes:[
      {op:"hypothetical",label:"items",quotedNumber:"25",value:25,unit:"item"},
      {op:"hypothetical",label:"percent",quotedNumber:"10",
        value:1000,unit:"ratio_bps"},{op:"multiply"},
    ]};
    expect(evaluateExpression(items,scope("What is 10% of 25 items?")))
      .toMatchObject({status:"conditional",value:2.5,unit:"item"});
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
