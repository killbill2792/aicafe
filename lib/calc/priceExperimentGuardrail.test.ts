import {describe,expect,it} from "vitest";
import {ordersGuardrail} from "./priceExperimentGuardrail";

const day=(value:number|null,w1:number|null,w2:number|null)=>({value,
  baseline:[{date:"2026-09-24",value:w1},{date:"2026-09-17",value:w2}]});
describe("price test orders guardrail",()=>{
  it("holds when café orders are close to the same weekdays before",()=>{
    expect(ordersGuardrail([day(98,100,100),day(102,100,100)])).toEqual(
      {status:"ok",countedDays:2,changePct:0,ordersNow:200,ordersBefore:200});
  });
  it("breaks at a 10% drop or more",()=>{
    expect(ordersGuardrail([day(90,100,100)])).toMatchObject({status:"broken",changePct:-10});
    expect(ordersGuardrail([day(91,100,100)])).toMatchObject({status:"ok",changePct:-9});
  });
  it("uses only days with a verified count and at least one verified week before",()=>{
    expect(ordersGuardrail([day(80,null,100),day(null,100,100),day(50,null,null),null]))
      .toMatchObject({status:"broken",countedDays:1,changePct:-20});
    expect(ordersGuardrail([null,day(null,1,1)])).toEqual({status:"unknown",countedDays:0});
  });
});
