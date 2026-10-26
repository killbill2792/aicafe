import {describe,expect,it} from "vitest";
import {nextDayCheckState,type DayCheckEvent,type DayCheckState} from "./dayCheckState";

const at="2026-10-25T21:00:00.000Z";
function day(overrides:Partial<DayCheckState>={}):DayCheckState{
 return {
  recon_state:"checked_internal",recon_source:"internal",internal_state:"matched",
  analytics_state:"pending",last_error_category:"rate_limited",
  warnings:{reconciliation_mismatch:1,analytics_timeout:1},
  payment_repull_at:"2026-10-24T09:00:00Z",
  last_recon_attempt_at:"2026-10-24T12:00:00Z",
  reconciled_at:"2026-10-24T12:00:00Z",
  internal_reasons:[],paid_other_day:0,...overrides
 };
}
const cases:Array<{label:string;event:DayCheckEvent}>= [
 {label:"internal match",event:{type:"internal_result",result:"matched",reasons:[],paidOtherDay:0}},
 {label:"internal mismatch",event:{type:"internal_result",result:"mismatch",reasons:["invalid_checks"],paidOtherDay:0}},
 {label:"payment recovery",event:{type:"payment_recovery_queued"}},
 {label:"ERA pending",event:{type:"era_pending"}},
 {label:"ERA matching result",event:{type:"era_result",matched:true,comparisonMatched:true,sourceIncomplete:false}},
 {label:"ERA mismatching result",event:{type:"era_result",matched:false,comparisonMatched:false,sourceIncomplete:false}},
 {label:"internal provider error",event:{type:"internal_error",category:"unavailable"}},
 {label:"ERA response error",event:{type:"era_error",category:"unavailable",permissionsLost:false}},
 {label:"ERA permission error",event:{type:"era_error",category:"authentication",permissionsLost:true}},
 {label:"ERA timeout",event:{type:"era_timeout"}},
 {label:"mode fallback",event:{type:"mode_downgraded"}},
 {label:"invalidated evidence",event:{type:"evidence_invalidated"}},
 {label:"reimported",event:{type:"reimported"}}
];
const startingStates=[
 ["internal match",day()],
 ["internal mismatch",day({recon_state:"mismatch",internal_state:"mismatch",
  warnings:{invalid_checks:1},internal_reasons:["invalid_checks"]})],
 ["pending proof",day({recon_state:"pending",recon_source:null,internal_state:null,analytics_state:null})],
 ["ERA mismatch",day({recon_state:"mismatch",recon_source:"toast_analytics",analytics_state:"available",
  internal_state:"matched",warnings:{reconciliation_mismatch:1}})],
 ["ERA matched",day({recon_state:"matched",recon_source:"toast_analytics",analytics_state:"available",
  warnings:{}})]
] as const;

const managedKeys=[
 "recon_state","recon_source","internal_state","analytics_state",
 "last_error_category","warnings","payment_repull_at","last_recon_attempt_at",
 "reconciled_at","internal_reasons","paid_other_day"
] as const;

describe("complete pure Toast day-check transitions",()=>{
 it("P1: every event emits only managed check columns, even given a full imported SQL row",()=>{
  const source={
   ...day(),
   business_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
   restaurant_guid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
   business_date:"2026-10-16",
   imported_at:"2026-10-17T10:00:00Z",
   last_import_run_id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
   orders_snapshot_sha256:"retained-import-checksum",
   net_sales_cents:12345,
   unparsed_count:2,
   coverage_complete:true,
   rechecking_reason:null,
   other_immutable_import_proof:"do not write"
  };
  for(const {label,event} of cases){
   const patch=nextDayCheckState(source,event,at);
   expect(Object.keys(patch).sort(),label).toEqual([...managedKeys].sort());
   expect(patch,"does not keep import metadata").not.toHaveProperty("imported_at");
   expect(patch,"does not overwrite sales").not.toHaveProperty("net_sales_cents");
  }
  expect(source.imported_at).toBe("2026-10-17T10:00:00Z");
 });
 for(const [label,current] of startingStates){
  describe("starting at "+label,()=>{
   for(const {label:action,event} of cases){
    it("always writes every managed state field for "+action,()=>{
     const result=nextDayCheckState(current,event,at);
     for(const key of ["recon_state","recon_source","internal_state","analytics_state",
      "last_error_category","warnings","payment_repull_at","last_recon_attempt_at",
      "internal_reasons","paid_other_day","reconciled_at"]){
      expect(result).toHaveProperty(key);
     }
     expect(current.last_recon_attempt_at).toBe("2026-10-24T12:00:00Z");
     expect(result.warnings).not.toBe(current.warnings);
     if(event.type!=="evidence_invalidated"&&event.type!=="reimported")
      expect(result.last_recon_attempt_at).toBe(at);
     else expect(result.last_recon_attempt_at).toBeNull();
    });
   }
  });
 }
 it("I1: no event except fresh ERA result or reimport clears existing ERA mismatch",()=>{
  const current=day({recon_state:"mismatch",recon_source:"toast_analytics",
   warnings:{reconciliation_mismatch:1}});
  for(const {event} of cases.filter(c=>!["era_result","reimported"].includes(c.event.type))){
   const result=nextDayCheckState(current,event,at);
   expect(result.recon_state,event.type).toBe("mismatch");
   expect(result.recon_source,event.type).toBe("toast_analytics");
  }
  const successful=nextDayCheckState(current,{type:"era_result",
   matched:true,comparisonMatched:true,sourceIncomplete:false},at);
  expect(successful.recon_state).toBe("matched");
  expect(successful.warnings).not.toHaveProperty("reconciliation_mismatch");
  const replaced=nextDayCheckState(current,{type:"reimported"},at);
  expect(replaced.recon_state).toBe("pending");
 });
 it("I1: payment recovery retains independent ERA mismatch and first deadline",()=>{
  const current=day({recon_state:"mismatch",recon_source:"toast_analytics",
   internal_state:"matched",payment_repull_at:"2026-10-20T12:00:00Z"});
  const next=nextDayCheckState(current,{type:"payment_recovery_queued"},at);
  expect(next).toMatchObject({recon_state:"mismatch",recon_source:"toast_analytics",
   payment_repull_at:"2026-10-20T12:00:00Z",internal_state:null});
 });
 it("I4: informational and successful outcomes clear old request errors, not mismatch evidence",()=>{
  const current=day({recon_state:"mismatch",recon_source:"toast_analytics"});
  for(const event of [{type:"era_pending"},{type:"era_timeout"},
   {type:"mode_downgraded"},{type:"era_result",matched:false,
    comparisonMatched:false,sourceIncomplete:false}] as DayCheckEvent[]){
   const next=nextDayCheckState(current,event,at);
   expect(next.last_error_category,event.type).toBeNull();
   expect(next.recon_state,event.type).toBe("mismatch");
  }
 });
 it("I7: unresolved recovery survives reimport, but a final internal verdict clears it",()=>{
  const current=day({payment_repull_at:"2026-10-20T12:00:00Z"});
  expect(nextDayCheckState(current,{type:"reimported"},at).payment_repull_at)
   .toBe(current.payment_repull_at);
  expect(nextDayCheckState(current,{type:"internal_result",
   result:"matched",reasons:[],paidOtherDay:0},at).payment_repull_at).toBeNull();
  expect(nextDayCheckState(current,{type:"internal_result",
   result:"mismatch",reasons:["invalid_checks"],paidOtherDay:0},at).payment_repull_at).toBeNull();
 });
 it("a fixed internal mismatch removes obsolete reasons while retaining unrelated warnings",()=>{
  const current=day({recon_state:"mismatch",internal_state:"mismatch",
   internal_reasons:["invalid_checks"],warnings:{invalid_checks:1,time_zone_mismatch:1}});
  const fixed=nextDayCheckState(current,{type:"internal_result",
   result:"matched",reasons:[],paidOtherDay:0},at);
  expect(fixed.warnings).not.toHaveProperty("invalid_checks");
  expect(fixed.warnings.time_zone_mismatch).toBe(1);
 });
});

it("internal API failures preserve official proof without fabricating Analytics pending status",()=>{
 const current=day({recon_state:"mismatch",recon_source:"toast_analytics",
  analytics_state:"available",internal_state:"mismatch"});
 const result=nextDayCheckState(current,{type:"internal_error",category:"unavailable"},at);
 expect(result).toMatchObject({recon_state:"mismatch",recon_source:"toast_analytics",
  analytics_state:"available",last_error_category:"unavailable"});
});
