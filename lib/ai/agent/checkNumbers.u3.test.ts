import {describe,expect,it} from "vitest";
import {compactEvidence,checkNumbers,hasVerifiedU3NumericObservation} from "./checkNumbers";
import type {AgentToolResult} from "./tools";

const receipt=()=>({
 source:"u3_canonical_research",period:null,missing:[],truncated:false,
 rows:[{amount_cents:"12345",orders:"7",percent:"12.34"}],
 evidence:{
  scope:"verified_owner_cafe_lease",
  receipt_id:"11111111-1111-4111-8111-111111111111",
  query_fingerprint:"a".repeat(64),catalog_version:"b".repeat(16),
  column_units:{amount_cents:"cents",orders:"count",percent:"percent"}
 }
}) as AgentToolResult;
describe("U3 SQL source receipts in numeric claim verification",()=>{
 it("accepts exact PostgreSQL NUMERIC strings without model calculator detours",()=>{
  const rows=compactEvidence([receipt()]);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.values).toEqual(expect.arrayContaining([
   expect.objectContaining({unit:"cents",value:12345}),
   expect.objectContaining({unit:"count",value:7}),
   expect.objectContaining({unit:"bps",value:1234})
  ]));
  expect(checkNumbers("$123.45, 7 orders and 12.34%.","",[receipt()],"en")).toEqual([]);
  expect(checkNumbers("$123.46 and 8 orders.","",[receipt()],"en")).not.toEqual([]);
 });
 it("uses identical receipt proof for unattended source admission",()=>{
  expect(hasVerifiedU3NumericObservation(receipt())).toBe(true);
  const original=receipt() as Record<string,unknown>;
  const proof=original.evidence as Record<string,unknown>;
  expect(hasVerifiedU3NumericObservation({...original,rows:[{fakeCents:99999}],
    evidence:{...proof,column_units:{}}} as unknown as AgentToolResult)).toBe(false);
 });
 it("does not promote missing scope, untyped aliases or partial responses",()=>{
  const original=receipt() as Record<string,unknown>;
  const proof=original.evidence as Record<string,unknown>;
  for(const altered of [
   {...original,evidence:{...proof,column_units:{}}},
   {...original,evidence:{...proof,scope:"unverified"}},
   {...original,evidence:{...proof,receipt_id:"forged"}},
   {...original,truncated:true},
   {...original,missing:["source_read_failed"]},
   {...original,error:"source_read_failed"},
  ]){
   expect(compactEvidence([altered as AgentToolResult]).flatMap(v=>v.values)).toEqual([]);
  }
 });
 it("never accepts model-authored numeric aliases through the generic object walker",()=>{
  const original=receipt() as Record<string,unknown>;
  const proof=original.evidence as Record<string,unknown>;
  const forged={...original,rows:[{
    fakeCents:99999,ordersCount:8,ratio:0.5,
    amount_cents:12345
  }],evidence:{...proof,column_units:{amount_cents:"cents"}}};
  const result=compactEvidence([forged as unknown as AgentToolResult]);
  expect(result.flatMap(x=>x.values)).toEqual([
   expect.objectContaining({unit:"cents",value:12345})
  ]);
  expect(checkNumbers("$999.99 and 8 orders.","",[forged as unknown as AgentToolResult],"en"))
   .not.toEqual([]);
  expect(checkNumbers("$123.45.","",[forged as unknown as AgentToolResult],"en")).toEqual([]);
  for(const untrusted of [
   {...original,rows:[{fakeCents:99999}],evidence:{...proof,column_units:{}}},
   {...original,rows:[{fakeCents:99999}],truncated:true},
   {...original,rows:[{fakeCents:99999}],missing:["source_read_failed"]},
  ]){
   expect(compactEvidence([untrusted as unknown as AgentToolResult]).flatMap(x=>x.values)).toEqual([]);
   expect(checkNumbers("$999.99.","",[untrusted as unknown as AgentToolResult],"en"))
    .not.toEqual([]);
  }
 });
 it("rejects fractional cents, unsafe huge integers and high-precision coercions",()=>{
  const original=receipt() as Record<string,unknown>;
  const bad={...original,rows:[{
   amount_cents:"12345.5",orders:"9007199254740993",percent:"12.3456789"
  }]};
  expect(compactEvidence([bad as unknown as AgentToolResult]).flatMap(v=>v.values)).toEqual([]);
 });
});

describe("recorded labor punch verifier, not roster or invented model prose",()=>{
 const id="12345678-1234-4123-8123-123456789abc";
 const observed={
   source:"labor_and_attendance",period:{from:"2026-11-15",to:"2026-11-15"},
   missing:[],attendance:{recordedTimecards:[{
     timecardId:id,employeeName:"Sam",localDate:"2026-11-15",
     clockIn:"2026-11-15T17:00:00Z",clockInLocal:"09:00",
     clockOut:"2026-11-15T23:00:00Z",clockOutLocal:"15:00",
     clockOutLocalDate:"2026-11-15",elapsedHours:6,
     recordedBreakCount:0,breakEvidence:"none_recorded",sourceType:"toast",
   }]},
 } as AgentToolResult;
 it("admits the employee's real duration and local clocks, never an assumed actual meal break",()=>{
   const entries=compactEvidence([observed]);
   expect(entries.flatMap(r=>r.values)).toEqual(expect.arrayContaining([
     expect.objectContaining({key:expect.stringContaining("elapsedHours"),value:6,unit:"count"}),
     expect.objectContaining({key:expect.stringContaining("recordedBreakCount"),value:0,unit:"count"}),
   ]));
   expect(checkNumbers("Sam clocked in at 9:00 AM on November 15, 2026. Sam clocked out at 3:00 PM on November 15, 2026. Sam worked 6 hours.","",[observed],"en")).toEqual([]);
 });
 it("rejects wrong person, wrong date, wrong clock and fabricated worked hours",()=>{
   for(const text of [
     "Maya clocked in at 9:00 AM on November 15, 2026.",
     "Maya had a clock-in at 9:00 AM on November 15, 2026.",
     "Maya’s recorded clock-in was 9:00 AM on November 15, 2026.",
     "Maya's recorded clock-in was 9:00 AM on November 15, 2026.",
     "Sam clocked in at 9:00 AM on November 16, 2026.",
     "Sam clocked in at 8:00 AM on November 15, 2026.",
     "Sam worked 7 hours.",
     "Maya worked 6 hours.",
     "Sam worked 6 hours on November 16, 2026.",
   ])expect(checkNumbers(text,"",[observed],"en")).not.toEqual([]);
 });
 it("withdraws old duration and clock-out proof when an authoritative punch is reopened",()=>{
   const saved=compactEvidence([observed]);
   const initial="Sam clocked out at 3:00 PM on November 15, 2026. Sam worked 6 hours.";
   expect(checkNumbers(initial,"",[], "en",saved)).toEqual([]);
   const card=(observed.attendance as {recordedTimecards:Array<Record<string,unknown>>}).recordedTimecards[0];
   const reopened={...observed,attendance:{recordedTimecards:[{
     ...card,clockOut:null,clockOutLocal:null,clockOutLocalDate:null,elapsedHours:null,
   }]}} as AgentToolResult;
   const unsupported=checkNumbers(initial,"",[reopened],"en",saved);
   expect(unsupported.length).toBeGreaterThan(0);
   expect(checkNumbers("Sam clocked in at 9:00 AM on November 15, 2026.","",
     [reopened],"en",saved)).toEqual([]);
 });
 it("preserves clock evidence beyond the thirtieth closed timecard after reconciliation",()=>{
   const cards=Array.from({length:31},(_,i)=>({
     timecardId:"00000000-0000-4000-8000-"+String(i+1).padStart(12,"0"),
     employeeName:"Sam",localDate:"2026-11-15",
     clockIn:"2026-11-15T"+String(17).padStart(2,"0")+":"+String(i).padStart(2,"0")+":00Z",
     clockInLocal:"09:"+String(i).padStart(2,"0"),
     clockOut:"2026-11-15T23:"+String(i).padStart(2,"0")+":00Z",
     clockOutLocal:"15:"+String(i).padStart(2,"0"),
     clockOutLocalDate:"2026-11-15",elapsedHours:6,recordedBreakCount:0,
     breakEvidence:"none_recorded",sourceType:"toast",
   }));
   const many={...observed,attendance:{recordedTimecards:cards}} as AgentToolResult;
   const saved=compactEvidence([many]);
   expect(checkNumbers("Sam clocked in at 9:30 AM on November 15, 2026.",
     "",[],"en",saved)).toEqual([]);
 });
 it("recognizes owner-facing named punch phrasing only for the right employee",()=>{
   expect(checkNumbers("Sam had a clock-in at 9:00 AM on November 15, 2026.","",
     [observed],"en")).toEqual([]);
   expect(checkNumbers("Sam’s recorded clock-in was 9:00 AM on November 15, 2026.","",
     [observed],"en")).toEqual([]);
   // Without person identity, a generic recorded punch can still be stated.
   expect(checkNumbers("Clock-in at 9:00 AM on November 15, 2026 was recorded.","",
     [observed],"en")).toEqual([]);
 });
 it("rejects a fabricated elapsed duration even when the tool shape resembles labor",()=>{
   const falseDuration={...observed,attendance:{recordedTimecards:[{
     ...(observed.attendance as {recordedTimecards:Array<Record<string,unknown>>}).recordedTimecards[0],
     elapsedHours:9,
   }]}};
   expect(compactEvidence([falseDuration as AgentToolResult]).flatMap(v=>v.values)
     .some(v=>v.key.endsWith("elapsedHours"))).toBe(false);
   expect(checkNumbers("Sam worked 9 hours.","",[falseDuration as AgentToolResult],"en")).not.toEqual([]);
 });
});
