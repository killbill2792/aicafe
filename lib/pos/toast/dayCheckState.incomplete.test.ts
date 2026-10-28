import {it,expect} from "vitest";
import {nextDayCheckState,type DayCheckState} from "./dayCheckState";
const current:DayCheckState={recon_state:"pending",recon_source:null,internal_state:null,
 analytics_state:null,last_error_category:null,warnings:{},
 payment_repull_at:null,last_recon_attempt_at:null,reconciled_at:null,
 internal_reasons:[],paid_other_day:0};
it("keeps unknown payment evidence incomplete rather than inventing a money mismatch",()=>{
 const r=nextDayCheckState(current,{
  type:"internal_incomplete",reasons:["unknown_payment_order"],paidOtherDay:0
 },"2026-10-28T12:00:00Z");
 expect(r.recon_state).toBe("pending");
 expect(r.internal_state).toBeNull();
 expect(r.internal_reasons).toContain("unknown_payment_order");
});
it("retains independently confirmed ERA mismatches",()=>{
 const r=nextDayCheckState({...current,recon_state:"mismatch",
  recon_source:"toast_analytics"},{
  type:"internal_incomplete",reasons:["missing_tax_cents"],paidOtherDay:0
 },"2026-10-28T12:00:00Z");
 expect(r.recon_state).toBe("mismatch");
 expect(r.recon_source).toBe("toast_analytics");
});
