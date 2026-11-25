import {describe,expect,it} from "vitest";
import {exactDecimal,exactNumber,runCalculation,type CalcValue} from "./calculator";
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


describe("U3 exact PostgreSQL numeric source arithmetic",()=>{
 it("never converts source decimal strings through binary floats",()=>{
  const a=exactDecimal("0.100000000000000001","count");
  const b=exactDecimal("0.200000000000000002","count");
  expect(a).not.toBeNull();expect(b).not.toBeNull();
  const result=runCalculation(new Map([["a",a!],["b",b!]]),[
   {id:"sum",op:"sum",args:["a","b"]}
  ]);
  expect(result.ok).toBe(true);
  if(result.ok){
   expect(result.result.value).toEqual(exactDecimal("0.300000000000000003","count"));
   expect(result.result.shown).toEqual({unit:"count",quantity:0.3});
  }
 });
 it("rejects exponent, nondecimal, absurd precision and nonfinite inputs",()=>{
  for(const value of ["NaN","Infinity","1e8","0."+"0".repeat(4096)+"1","1,200",""])
   expect(exactDecimal(value,"cents")).toBeNull();
  expect(exactDecimal("1200","cents")).toMatchObject({n:BigInt(1200),d:BigInt(1)});
  expect(exactDecimal("1.000000000000000000000001","cents")).toEqual({
   n:BigInt("1000000000000000000000001"),d:BigInt("1000000000000000000000000"),unit:"cents"});
  expect(exactDecimal("1200."+"0".repeat(100),"cents")).toEqual(exactDecimal("1200","cents"));
 });
});

describe("calculator physical arithmetic limits, not business step counts",()=>{
 it("preserves a tiny finite input instead of rounding it to zero",()=>{
  expect(exactNumber(1e-12,"ratio")).toEqual({n:BigInt(1),d:BigInt(1000000000000),unit:"ratio"});
 });
 it("accepts many independent costs and many sequential steps",()=>{
  const inputs=Object.fromEntries(Array.from({length:40},(_,i)=>["v"+i,cents(i+1)]));
  const steps:Parameters<typeof runCalculation>[1]=[
   {id:"total",op:"sum",args:Object.keys(inputs)},
   ...Array.from({length:40},(_,i)=>({id:"s"+i,op:"sum" as const,args:[i===0?"total":"s"+(i-1)]}))
  ];
  expect(run(inputs,steps)).toMatchObject({ok:true,result:{shown:{unit:"cents",valueCents:820}}});
 });
 it("stops exponential exact-denominator growth even when displayed values remain tiny",()=>{
  const steps=Array.from({length:20},(_,i)=>({id:"s"+i,op:"multiply" as const,args:Array(2).fill(i===0?"rate":"s"+(i-1))}));
  expect(run({rate:exactDecimal("0.1","ratio")!},steps)).toMatchObject({ok:false,code:"arithmeticResourceLimit"});
 });
});

describe("source-typed duration arithmetic",()=>{
  it("adds compatible durations exactly and divides across duration units",()=>{
    const a=exactDecimal("1.25","hours")!,b=exactDecimal("45","minutes")!;
    const r=run({a,b},[{id:"total",op:"add",args:["a","b"]},{id:"ratio",op:"divide",args:["total","b"]}]);
    expect(r.ok&&r.steps[0].shown).toEqual({unit:"hours",valueDuration:2});
    expect(r.ok&&r.result.shown).toEqual({unit:"ratio",valueRatio:2.6667});
  });
  it("never combines unrelated counts with durations by addition",()=>{
    expect(run({a:exactDecimal("7","hours")!,b:count(7)},[{id:"total",op:"add",args:["a","b"]}])).toMatchObject({ok:false,code:"unitsDiffer"});
    expect(run({a:exactDecimal("7","hours")!,b:exactDecimal("2","minutes")!},[{id:"total",op:"multiply",args:["a","b"]}])).toMatchObject({ok:false,code:"unitsCannotMultiply"});
  });
 });
