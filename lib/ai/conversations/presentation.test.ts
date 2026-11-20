import {describe,it,expect} from "vitest";
import {richPresentationSchema,presentationReport,interactiveCalcSchema,evaluatePresentationCalc} from "./presentation";
describe("Task16E presentation snapshot and safe report",()=>{
 it("preserves the source-marked answer and exact minor unit values, not executable content",()=>{
  const p=richPresentationSchema.parse({type:"rich_presentation",version:1,layout:"stack",report:true,suggestions:[],panels:[
    {kind:"metric",title:"Recorded sales",unit:"cents",currency:"SAR",from:"2026-01-01",to:"2026-01-01",asOf:"2026-01-02",source:"daily_rollups",points:[{label:"Recorded sales",value:12345}]}]});
  const text="Estimate 10.";
  const report=presentationReport(p,{blocks:[{type:"text",text},{type:"proposal_card",proposalId:"hidden-id"}],createdAt:"2026-01-02",grounding:{status:"partial",agentMetadata:{unverified:[{blockIndex:0,start:9,end:11,source:"estimate"}]}}});
  expect(report).toContain(text);expect(report).toContain("10 — Estimate");expect(report).toContain("12345 cents (SAR)");
  expect(report).not.toContain("hidden-id");expect(report).toContain("Answer status: partial");
 });
 it("rejects unknown executable props and malformed numeric and dated blocks without affecting legacy text",()=>{
  const base={type:"rich_presentation",version:1,layout:"stack",report:true,panels:[],suggestions:[]};
  expect(richPresentationSchema.safeParse(base).success).toBe(true);
  expect(richPresentationSchema.safeParse({...base,on:{click:"approve"}}).success).toBe(false);
  expect(richPresentationSchema.safeParse({...base,version:2}).success).toBe(false);
  expect(richPresentationSchema.safeParse({...base,agenda:{source:"cafe_events",kind:"calendar",title:"Events",asOf:"2026-01-01",from:"2026-01-05",to:"2026-01-01",coverage:"saved",entries:[]}}).success).toBe(false);
 });
});

describe("bounded local calculation using canonical arithmetic",()=>{
 const calc=interactiveCalcSchema.parse({title:"Milk order estimate",currency:"SAR",asOf:"2026-11-01",
  inputs:[{id:"cost",label:"Unit cost",value:{unit:"cents",valueCents:250},editable:false},
    {id:"quantity",label:"Quantity",value:{unit:"count",quantity:10},editable:true}],
  steps:[{id:"total",op:"multiply",args:["cost","quantity"]}],original:{unit:"cents",valueCents:2500}});
 it("matches the original calculation and changes only a valid owner input",()=>{
  expect(evaluatePresentationCalc(calc)).toEqual(calc.original);
  expect(evaluatePresentationCalc(calc,{quantity:"12"})).toEqual({unit:"cents",valueCents:3000});
  expect(evaluatePresentationCalc(calc,{quantity:"0",cost:"999"})).toEqual({unit:"cents",valueCents:0});
  expect(evaluatePresentationCalc(calc,{quantity:"12",cost:"999"})).toEqual({unit:"cents",valueCents:3000});
  for(const value of ["","NaN","Infinity","1e9","1000000000","2.123","alert(1)"])expect(evaluatePresentationCalc(calc,{quantity:value})).toBeNull();
 });
 it("rejects malformed or effect-bearing schemas",()=>{
  expect(interactiveCalcSchema.safeParse({...calc,steps:[{id:"send",op:"approve",args:["quantity"]}]}).success).toBe(false);
  expect(interactiveCalcSchema.safeParse({...calc,currency:null}).success).toBe(false);
 });
});
