import {describe,expect,it} from "vitest";
import {compactEvidence,checkNumbers,hasVerifiedU3NumericObservation} from "./checkNumbers";
import type {AgentToolResult} from "./tools";
import {statusFromResults} from "./status";

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
 it("uses attested duration units instead of trusting model-selected count aliases",()=>{
  const base=receipt();
  const count={...base,rows:[{hours:"7"}],evidence:{...(base.evidence as object),column_units:{hours:"count"}}};
  const duration={...base,rows:[{elapsed:"7"}],evidence:{...(base.evidence as object),column_units:{elapsed:"hours"}}};
  expect(checkNumbers("The recorded duration was 7 hours.","",[duration],"en")).toEqual([]);
  expect(checkNumbers("The recorded duration was 7 hours.","",[count],"en")).not.toEqual([]);
  expect(checkNumbers("There were 7 orders.","",[duration],"en")).not.toEqual([]);
  const misleadingAlias={...duration,rows:[{quantity:"7"}],evidence:{...(duration.evidence as object),column_units:{quantity:"hours"}}};
  expect(checkNumbers("There were 7 orders.","",[misleadingAlias],"en")).not.toEqual([]);
  expect(checkNumbers("The recorded duration was 7 minutes.","",[duration],"en")).not.toEqual([]);
  const seconds={...duration,evidence:{...(duration.evidence as object),column_units:{elapsed:"seconds"}}};
  expect(checkNumbers("The recorded duration was 7 seconds.","",[seconds],"en")).toEqual([]);
  expect(checkNumbers("The recorded duration was 7 seconds.","",[count],"en")).not.toEqual([]);
 });
 it("verifies a stored basis-point rate in percentage units",()=>{
  const base=receipt();
  const r={...base,rows:[{rate:"1250"}],evidence:{...(base.evidence as object),column_units:{rate:"basis_points"}}};
  expect(compactEvidence([r]).flatMap(v=>v.values)).toEqual([expect.objectContaining({unit:"bps",value:1250})]);
  expect(checkNumbers("The saved rate is 12.5%.","",[r],"en")).toEqual([]);
 });
 it("verifies ingredient microcent rates in display currency, not as raw whole cents",()=>{
  const base=receipt();
  const r={...base,rows:[{rate:"2000000"}],evidence:{...(base.evidence as object),column_units:{rate:"microcents"}}};
  expect(compactEvidence([r]).flatMap(v=>v.values)).toEqual([expect.objectContaining({unit:"cents",value:2})]);
  expect(checkNumbers("Ingredient cost is $0.02 per gram.","",[r],"en")).toEqual([]);
  expect(checkNumbers("Ingredient cost is $20,000 per gram.","",[r],"en")).not.toEqual([]);
 });
 it("rounds only source-attested display amounts and refuses unsafe huge integers",()=>{
  const original=receipt() as Record<string,unknown>;
  const bad={...original,rows:[{
   amount_cents:"12345.5",orders:"9007199254740993",percent:"12.3456789"
  }]};
  expect(compactEvidence([bad as unknown as AgentToolResult]).flatMap(v=>v.values)).toEqual([
   expect.objectContaining({unit:"cents",value:12346}),expect.objectContaining({unit:"bps",value:1235})
  ]);
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
     "Maya had her clock-in at 9:00 AM on November 15, 2026.",
     "Maya’s timecard lists a clock-in at 9:00 AM on November 15, 2026.",
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
 it("checks every returned current-turn punch, including beyond the old clock cap",()=>{
   const base=(observed.attendance as {recordedTimecards:Array<Record<string,unknown>>}).recordedTimecards[0];
   const cards=Array.from({length:100},(_,i)=>({...base,
     timecardId:"00000000-0000-4000-8000-"+String(i+1).padStart(12,"0"),
     ...(i===99?{employeeName:"Maya",clockIn:"2026-11-15T18:05:00Z",clockInLocal:"10:05",
      clockOut:"2026-11-16T00:05:00Z",clockOutLocal:"16:05"}:{})
   }));
   const many={...observed,attendance:{recordedTimecards:cards}} as AgentToolResult;
   expect(compactEvidence([many],Infinity).flatMap(r=>r.times)).toHaveLength(200);
   expect(checkNumbers("Maya clocked in at 10:05 AM on November 15, 2026.",
     "",[many],"en")).toEqual([]);
   expect(checkNumbers("Maya clocked in at 9:00 AM on November 15, 2026.",
     "",[many],"en")).not.toEqual([]);
 });
 it("preserves earlier independent pages and withdraws a corrected record by identity",()=>{
   const first=(observed.attendance as {recordedTimecards:Array<Record<string,unknown>>}).recordedTimecards[0];
   const second={...first,timecardId:"22345678-1234-4123-8123-123456789abc",employeeName:"Maya",clockIn:"2026-11-15T18:05:00Z",clockInLocal:"10:05",clockOut:"2026-11-16T00:05:00Z",clockOutLocal:"16:05"};
   const page=(card:Record<string,unknown>,offset:number)=>({...observed,attendance:{recordedTimecards:[card],recordedTimecardsPageOffset:offset}}) as AgentToolResult;
   expect(checkNumbers("Sam clocked in at 9:00 AM on November 15, 2026. Maya clocked in at 10:05 AM on November 15, 2026.","",[page(first,0),page(second,100)],"en")).toEqual([]);
   expect(checkNumbers("Maya clocked out at 4:05 PM on November 15, 2026.","",[page(first,0),page(second,100),page({...second,clockOut:null,clockOutLocal:null,elapsedHours:null},100)],"en")).not.toEqual([]);
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
 it("selects the closest punch, operating-hours or shift action per clock",()=>{
   for(const assertion of [
     "Sam clocked in at 9:00 AM and the café opens at 9:00 AM on November 15, 2026.",
     "Sam clocked in at 9:00 AM and the café closes at 9:00 AM on November 15, 2026.",
     "Sam clocked in at 9:00 AM and her shift starts at 9:00 AM on November 15, 2026.",
     "The café opens at 9:00 AM and Sam clocked in at 9:00 AM on November 15, 2026.",
   ])expect(checkNumbers(assertion,"",[observed],"en")).not.toEqual([]);
   expect(checkNumbers(
     "Sam clocked in at 9:00 AM and Sam clocked out at 3:00 PM on November 15, 2026.",
     "",[observed],"en")).toEqual([]);
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

describe("complete SQL snapshot receipts across pages",()=>{
 const page=(offset:number,amount:string,final:boolean,digest="c".repeat(64)):AgentToolResult=>{
  const base=receipt();
  return {...base,rows:[{amount_cents:amount}],rowCount:1,
   page_consistency:"verified_same_result",total_rows:2,page_offset:offset,
   page_complete:final,truncated:!final,next_cursor:final?null:"signed-cursor",
   missing:final?[]:["result_truncated"],
   evidence:{...(base.evidence as object),
    receipt_id:offset?"22222222-2222-4222-8222-222222222222":"11111111-1111-4111-8111-111111111111",
    snapshot_id:"33333333-3333-4333-8333-333333333333",snapshot_digest:digest,
    as_of:"2026-11-24T00:00:00Z"}};
 };
 const status=(rows:AgentToolResult[])=>statusFromResults(rows.map((result,i)=>({
  name:"query_data",callId:String(i),arguments:JSON.stringify({cursor:i}),result})));
 it("verifies early and final rows after a complete same-result traversal without clearing unrelated gaps",()=>{
  const first=page(0,"12345",false),last=page(1,"54321",true);
  expect(status([first,last])).toEqual({status:"complete",missing:[]});
  expect(checkNumbers("$123.45 and $543.21.","",[first,last],"en")).toEqual([]);
  expect(status([first,last,{source:"expenses",period:null,missing:["expense_gap"]}]))
   .toEqual({status:"partial",missing:["expense_gap"]});
  expect(first.truncated).toBe(true); // original provider receipt is unchanged
 });
 it("does not accept missing prefixes, different snapshots or other business gaps as complete",()=>{
  const first=page(0,"12345",false),last=page(1,"54321",true);
  for(const rows of [[first],[last],[first,page(1,"54321",true,"d".repeat(64))],
   [{...first,missing:["result_truncated","source_read_failed"]},last]]){
   expect(status(rows).status).toBe("partial");
   expect(compactEvidence(rows).flatMap(x=>x.values)).toEqual([]);
  }
 });
});

describe("direct SQL source-row provenance",()=>{
 const fields={card:"timecard_id",worker:"employee_name",tz:"timezone",start:"clock_in",finish:"clock_out",breaks:"recorded_break_count"};
 const row={card:"12345678-1234-4123-8123-123456789abc",worker:"Sam",tz:"America/Los_Angeles",start:"2026-11-15T17:00:00Z",finish:"2026-11-15T23:00:00Z",breaks:0};
 const make=(workerBinding=1,extra:Record<string,unknown>={})=>({...receipt(),rows:[{...row,...extra}],evidence:{...(receipt().evidence as object),column_units:{},
  column_origins:Object.fromEntries(Object.entries(fields).map(([label,column])=>[label,{relation:"recorded_timecards",column,binding:label==="worker"?workerBinding:1}]))}}) as AgentToolResult;
 it("keeps direct SQL duration tied to the employee binding rather than its numeric alias",()=>{
  const base=make();
  const typed={...base,rows:[{...row,quantity:"7"}],evidence:{...(base.evidence as object),column_units:{quantity:"hours"},
    column_origins:{...(base.evidence as {column_origins:object}).column_origins,quantity:{relation:"recorded_timecards",column:"provider_regular_hours",binding:1}}}};
  expect(checkNumbers("Sam worked 7 hours.","",[typed],"en")).toEqual([]);
  expect(checkNumbers("Maya worked 7 hours.","",[typed],"en")).not.toEqual([]);
  expect(checkNumbers("There were 7 orders.","",[typed],"en")).not.toEqual([]);
 });
 it("binds an elapsed expression to the actual recorded timecard dependencies",()=>{
  const base=make();
  const derived={...base,rows:[{...row,elapsed:"6"}],evidence:{...(base.evidence as object),column_units:{elapsed:"hours"},
    column_dependencies:{elapsed:[{relation:"recorded_timecards",column:"clock_in",binding:1},{relation:"recorded_timecards",column:"clock_out",binding:1}]}}};
  expect(checkNumbers("Sam worked 6 hours.","",[derived],"en")).toEqual([]);
  expect(checkNumbers("Maya worked 6 hours.","",[derived],"en")).not.toEqual([]);
 });
 it("verifies real SQL clock observations and duration, not model-selected aliases or different rows",()=>{
  expect(checkNumbers("Sam clocked in at 9:00 AM on November 15, 2026. Sam worked 6 hours.","",[make()],"en")).toEqual([]);
  expect(checkNumbers("Sam clocked in at 9:00 AM on November 15, 2026.","",[make(2)],"en")).not.toEqual([]);
  expect(checkNumbers("Sam clocked in at 10:00 AM on November 15, 2026.","",[make()],"en")).not.toEqual([]);
  const prior=compactEvidence([make()]);
  expect(checkNumbers("Sam clocked out at 3:00 PM on November 15, 2026.","",[make(1,{finish:null})],"en",prior)).not.toEqual([]);
 });
});


describe("SQL daily source-row date and metric evidence",()=>{
 const make=(status="actual",binding=1,amount="12345")=>({...receipt(),rows:[{day:"2026-11-15",total:amount,state:status}],evidence:{...(receipt().evidence as object),column_units:{total:"cents"},column_origins:{day:{relation:"daily_rollups",column:"business_date",binding:1},total:{relation:"daily_rollups",column:"net_sales_cents",binding},state:{relation:"daily_rollups",column:"sales_data_status",binding:1}}}}) as AgentToolResult;
 it("accepts directly observed daily sales without a reporting-tool requirement",()=>{
  expect(checkNumbers("Sales on 2026-11-15 were $123.45.","",[make()],"en")).toEqual([]);
  for(const wrong of ["Sales on 2026-11-16 were $123.45.","Labor on 2026-11-15 was $123.45."])
   expect(checkNumbers(wrong,"",[make()],"en")).not.toEqual([]);
  expect(checkNumbers("Sales on 2026-11-15 were $123.45.","",[make("missing")],"en")).not.toEqual([]);
  expect(checkNumbers("Sales on 2026-11-15 were $123.45.","",[make("actual",2)],"en")).not.toEqual([]);
 });
 it("withdraws a previously observed daily total when refreshed as missing",()=>{
  const saved=compactEvidence([make()]);
  expect(checkNumbers("Sales on 2026-11-15 were $123.45.","",[make("missing")],"en",saved)).not.toEqual([]);
 });
});

describe("SQL roster clock provenance",()=>{
 const shift={id:"shift-a",employee_id:"worker-a",local_date:"2026-11-19",start_local:"07:00:00",end_local:"14:00:00",overnight:false,status:"sent",source:"owner",deleted_at:null};
 const row={...shift,worker_id:"worker-a",worker_name:"Ada"};
 const origins={...Object.fromEntries(Object.keys(shift).map(column=>[column,{relation:"scheduled_shifts",column,binding:1}])),
  worker_id:{relation:"employees",column:"id",binding:2},
  worker_name:{relation:"employees",column:"display_name",binding:2}};
 const make=(changes:Record<string,unknown>={},additionalRows:Record<string,unknown>[]=[]):AgentToolResult=>({
  ...receipt(),rows:[{...row,...changes},...additionalRows],
  evidence:{...(receipt().evidence as object),column_units:{},column_origins:origins}
 });
 const claim="Ada's shift starts at 07:00 on 2026-11-19.";
 it("accepts the exact dated joined roster clock, not another worker, day, or actual punch",()=>{
  expect(checkNumbers(claim,"",[make()],"en")).toEqual([]);
  for(const text of ["Bob's shift starts at 07:00 on 2026-11-19.","Ada's shift starts at 08:00 on 2026-11-19.","Ada's shift starts at 07:00 on 2026-11-20.","Ada clocked in at 07:00 on 2026-11-19."])
   expect(checkNumbers(text,"",[make()],"en")).not.toEqual([]);
  expect(checkNumbers(claim,"",[make({worker_id:"worker-b"})],"en")).not.toEqual([]);
  expect(checkNumbers(claim,"",[make({worker_id:"worker-b"},[{...row,id:"shift-b",start_local:"10:00:00"}])],"en")).not.toEqual([]);
 });
 it("withdraws revised or removed shifts by identity without wiping independent shifts",()=>{
  const prior=compactEvidence([make({},[{...row,id:"shift-b",start_local:"10:00:00"}])]);
  for(const changes of [{start_local:"09:00:00"},{deleted_at:"2026-11-19T01:00:00Z"},{status:"draft",source:"olivia"}]){
   expect(checkNumbers(claim,"",[make(changes)],"en",prior)).not.toEqual([]);
   expect(checkNumbers("Ada's shift starts at 10:00 on 2026-11-19.","",[make(changes)],"en",prior)).toEqual([]);
  }
 });
 it("uses the next local date for an overnight shift end",()=>{
  expect(checkNumbers("Ada's shift ends at 02:00 on 2026-11-20.","",[make({start_local:"20:00:00",end_local:"02:00:00",overnight:true})],"en")).toEqual([]);
 });
});
