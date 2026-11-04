import {describe,expect,it} from "vitest";
import {exactNumber,runCalculation,type CalcValue} from "./calculator";
const cents=(n:number)=>exactNumber(n,"cents")!;
const pct=(n:number)=>exactNumber(n,"percent",100)!;
const count=(n:number)=>exactNumber(n,"count")!;
const run=(inputs:Record<string,CalcValue>,steps:Parameters<typeof runCalculation>[1])=>
  runCalculation(new Map(Object.entries(inputs)),steps);

describe("general calculator",()=>{
  it("takes a percent of money exactly, rounding only when shown",()=>{
    const r=run({sales:cents(481237),share:pct(20)},[{id:"ing",op:"percent_of",args:["share","sales"]}]);
    expect(r.ok&&r.result.shown).toEqual({unit:"cents",valueCents:96247});
  });
  it("keeps exact fractions between steps (no rounding drift)",()=>{
    // 100 ÷ 3 × 3 is exactly 100, never 99.
    const r=run({total:cents(100),parts:count(3)},[
      {id:"each",op:"divide",args:["total","parts"]},
      {id:"back",op:"multiply",args:["each","parts"]}]);
    expect(r.ok&&r.steps.map(s=>s.shown)).toEqual([{unit:"cents",valueCents:33},{unit:"cents",valueCents:100}]);
  });
  it("adds, subtracts and sums in the same unit",()=>{
    const r=run({a:cents(50000),b:cents(4000),c:cents(20000)},[
      {id:"x",op:"subtract",args:["a","b"]},{id:"y",op:"add",args:["x","c"]},{id:"z",op:"sum",args:["a","b","c"]}]);
    expect(r.ok&&r.steps.map(s=>s.shown)).toEqual([
      {unit:"cents",valueCents:46000},{unit:"cents",valueCents:66000},{unit:"cents",valueCents:74000}]);
  });
  it("gives a share when dividing money by money",()=>{
    const r=run({cost:cents(25000),sales:cents(100000)},[{id:"s",op:"divide",args:["cost","sales"]}]);
    expect(r.ok&&r.result.shown).toEqual({unit:"percent",valueBps:2500});
  });
  it("rounds half away from zero, also for negatives",()=>{
    expect(run({a:cents(5),n:count(2)},[{id:"x",op:"divide",args:["a","n"]}])).toMatchObject({ok:true,result:{shown:{valueCents:3}}});
    expect(run({a:cents(-5),n:count(2)},[{id:"x",op:"divide",args:["a","n"]}])).toMatchObject({ok:true,result:{shown:{valueCents:-3}}});
  });
  it("fails closed on meaningless or unsafe math",()=>{
    expect(run({a:cents(1),b:cents(2)},[{id:"x",op:"multiply",args:["a","b"]}])).toEqual({ok:false,code:"unitsCannotMultiply",stepId:"x"});
    expect(run({a:cents(1),b:count(2)},[{id:"x",op:"add",args:["a","b"]}])).toEqual({ok:false,code:"unitsDiffer",stepId:"x"});
    expect(run({a:cents(1),z:count(0)},[{id:"x",op:"divide",args:["a","z"]}])).toEqual({ok:false,code:"divideByZero",stepId:"x"});
    expect(run({a:cents(1)},[{id:"x",op:"add",args:["a","nope"]}])).toEqual({ok:false,code:"unknownArg:nope",stepId:"x"});
    expect(run({a:cents(1)},[{id:"a",op:"sum",args:["a"]}])).toEqual({ok:false,code:"duplicateName",stepId:"a"});
    expect(run({a:cents(Number.MAX_SAFE_INTEGER),n:count(10)},[{id:"x",op:"multiply",args:["a","n"]}]))
      .toEqual({ok:false,code:"valueTooLarge",stepId:"x"});
  });
  it("reads decimals exactly",()=>{
    expect(exactNumber(2.9,"percent",100)).toEqual({n:BigInt(29),d:BigInt(1000),unit:"percent"});
    expect(exactNumber(Number.NaN,"count")).toBeNull();
  });
});
