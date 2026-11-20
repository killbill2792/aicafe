import {describe,it,expect} from "vitest";
import {richPresentationSchema,presentationReport,interactiveCalcSchema,evaluatePresentationCalc,agendaSchema,calendarPage} from "./presentation";
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

it("rejects duplicate, foreign and incompatible layout references",()=>{
 const p={kind:"metric",title:"Sales",unit:"cents",currency:"SAR",from:"2026-01-01",to:"2026-01-01",asOf:"2026-01-02",source:"daily_rollups",points:[{label:"Sales",value:12}]};
 const b={type:"rich_presentation",version:1,layout:"stack",panels:[p],suggestions:[]};
 expect(richPresentationSchema.safeParse({...b,groups:[{layout:"grid",items:["panel0","panel0"]}]}).success).toBe(false);
 expect(richPresentationSchema.safeParse({...b,groups:[{layout:"stack",items:["table0"]}]}).success).toBe(false);
 expect(richPresentationSchema.safeParse({...b,panels:[p,{...p,unit:"count",currency:null}],groups:[{layout:"compare",items:["panel0","panel1"]}]}).success).toBe(false);
});

it("retains dates spanning weeks and calendar pages without inventing an occurrence",()=>{
 const a=agendaSchema.parse({kind:"calendar",source:"cafe_events",title:"Saved events",from:"2026-01-01",to:"2026-02-15",asOf:"2026-01-01",coverage:"partial",entries:[
  {label:"Market",date:"2026-01-27",endDate:"2026-01-30",start:null,end:null,status:"unverified",checkedAt:null}]});
 const first=calendarPage(a,0),second=calendarPage(a,1);
 expect(first.days.at(-1)?.entries[0].label).toBe("Market");
 expect(second.days[0].date).toBe("2026-01-29");
 expect(second.days[0].entries[0].label).toBe("Market");
 expect(second.days[2].entries).toEqual([]);
 expect(second.pages).toBe(2);
});

 it("accepts recursive compositions of existing evidence and rejects cycles, repeated subtrees, dangling and over-depth graphs",()=>{
 const p={kind:"metric",title:"Sales",unit:"cents",currency:"SAR",from:"2026-01-01",to:"2026-01-01",asOf:"2026-01-02",source:"daily_rollups",points:[{label:"Sales",value:12}]};
 const b={type:"rich_presentation",version:1,layout:"stack",panels:[p,{...p,title:"Cost"},{...p,title:"Profit"}],suggestions:[]};
 const groups=[{id:"g0",layout:"stack",items:["g1","panel2"]},{id:"g1",layout:"grid",items:["g2"]},{id:"g2",layout:"compare",items:["panel0","panel1"]}];
 expect(richPresentationSchema.safeParse({...b,groups}).success).toBe(true);
 for(const invalid of [[...groups,{id:"g3",layout:"grid",items:["g1"]}],[{...groups[0],items:["g1","g0"]},...groups.slice(1)],[{...groups[0],items:["g9","panel2"]},...groups.slice(1)],[...groups,{...groups[2]}]])expect(richPresentationSchema.safeParse({...b,groups:invalid}).success).toBe(false);
 const deep=Array.from({length:7},(_,i)=>({id:"g"+i,layout:"stack",items:i===6?["panel0","panel1","panel2"]:["g"+(i+1)]}));
 expect(richPresentationSchema.safeParse({...b,groups:deep}).success).toBe(false);
 });
