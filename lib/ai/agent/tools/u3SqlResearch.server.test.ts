import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {unsafeStructuredToastResult,selectU3Catalog,safeU3SqlDiagnostic,type U3Relation} from "./u3SqlResearch.server";
import {U3AdmissionError} from "./u3SqlAdmission";

describe("U3 retained Toast result safety",()=>{
 it("permits approved scalar observations and dates",()=>{
  expect(unsafeStructuredToastResult([
   {record_type:"check",count:7,amount_cents:"12345",observed_at:new Date("2026-11-20T00:00:00Z")},
   {name:"Vanilla Latte",business_date:"2026-11-19",missing:null}
  ])).toBe(false);
 });
 it("refuses raw objects, arrays, serialized nested JSON and unknown row shapes",()=>{
  for(const payload of [
   [{data:{customer:{firstName:"test",accessToken:"not visible"}}}],
   [{alias:[{secret:"not visible"}]}],
   [{alias:'{"customer":{"cardNumber":"never send"}}'}],
   [{alias:'[{"paymentToken":"never send"}]'}],
   [{alias:Buffer.from("blocked")}],
   [null]
  ])expect(unsafeStructuredToastResult(payload)).toBe(true);
 });
 it("does not mistake ordinary scalar strings for a structured record",()=>{
  expect(unsafeStructuredToastResult([{value:"{not parsed}"},
   {value:"Vanilla [large]"}, {value:"12345.00"}])).toBe(false);
 });
});

describe("connector-style research discovery and safe repair diagnostics",()=>{
 const catalog:U3Relation[]=Array.from({length:42},(_,i)=>({
  name:i===41?"timecards":"relation_"+i,description:i===41?"Recorded staff punches":null,
  relationships:[],columns:Array.from({length:35},(_,j)=>({name:"field_"+j,type:"text",nullable:true,unit:"source_defined"}))
 }));
 it("does not hide relations or matching relation fields behind implicit pages",()=>{
  expect(selectU3Catalog(catalog,{})).toMatchObject({total:42,next_offset:null,truncated:false});
  expect(selectU3Catalog(catalog,{}).relations).toHaveLength(42);
  expect(selectU3Catalog(catalog,{search:"timecards"}).relations[0].columns).toHaveLength(35);
  expect(selectU3Catalog(catalog,{relation:"timecards"}).relations[0].columns).toHaveLength(35);
  const page=selectU3Catalog(catalog,{relation:"timecards",limit:30});
  expect(page).toMatchObject({next_offset:30,truncated:true,missing:["result_truncated"]});
  expect(selectU3Catalog(catalog,{relation:"timecards",offset:30,limit:30}).relations[0].columns).toHaveLength(5);
 });
 it("continues relation detail using available context bytes",()=>{
   const first=selectU3Catalog(catalog,{relation:"timecards"},1200);
   expect(first.next_offset).toBeGreaterThan(0);
   expect(first.next_offset).toBeLessThan(35);
   expect(first.truncated).toBe(true);
   const second=selectU3Catalog(catalog,{relation:"timecards",offset:first.next_offset});
   expect([...first.relations[0].columns,...second.relations[0].columns]).toEqual(catalog[41].columns);
  });
  it("returns useful fixed PostgreSQL diagnostics, never raw source values or messages",()=>{
  const err={code:"42703",position:String("DECLARE u3_result NO SCROLL CURSOR FOR SELECT * FROM (".length+8),message:"secret column value",detail:"private",hint:"private"};
  expect(safeU3SqlDiagnostic(err,20)).toEqual({sqlstate:"42703",reason:"undefined_column",query_position:8});
  expect(safeU3SqlDiagnostic({...err,position:"999999"},20)).toEqual({sqlstate:"42703",reason:"undefined_column"});
  expect(safeU3SqlDiagnostic({code:"unknown",message:"private"},20)).toBeUndefined();
  expect(safeU3SqlDiagnostic(new U3AdmissionError("unapproved_function"),20)).toEqual({reason:"unapproved_function"});
 });
});
