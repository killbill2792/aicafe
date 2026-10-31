import {describe,expect,it} from "vitest";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";
import type {OwnerProposalRow} from "@/lib/ai/supervisor/loop/reads.server";
import {prepareMorningBrief,type MorningBriefEvidence} from "./morningBrief";

const now=new Date("2026-10-31T16:00:00.000Z");
const event:CafeEvent={
  id:"event-1",name:"Halloween festival",kind:"festival",startDate:"2026-10-31",
  endDate:"2026-10-31",startTime:"15:00:00",endTime:null,venue:"Moscone Center",
  venueAddress:null,areaLabel:null,sourceUrl:"https://example.org/festival",status:"found",
  foundAt:"2026-10-27T18:00:00Z",lastCheckedAt:"2026-10-30T20:00:00Z",
  lastVerifiedAt:"2026-10-30T20:00:00Z",
};
const monitor:OwnerProposalRow={
 id:"monitor-1",thread_id:"thread-1",capability_id:"alex.daily_sales.v1",revision:1,
 status:"committed",canonical_effect_payload:{},baseline:{},
 monitor_spec:{metricScope:"same_weekday_sales",durationDays:7},
 monitoring_start_date:"2026-10-29",created_at:"2026-10-28T15:00:00Z",
};
function evidence(overrides:Partial<MorningBriefEvidence>={}):MorningBriefEvidence{
 return {businessId:"cafe-1",businessName:"Café One",currency:"EUR",
   today:"2026-10-31",yesterday:"2026-10-30",netSalesCents:240000,salesStatus:"actual",
   itemCoverage:true,
   soldItems:[{id:"latte-small",units:5},{id:"latte-large",units:4},
     {id:"tea",units:2},{id:"sandwich",units:7}],
   menu:[{id:"latte-small",name:"Latte 12 oz",base_name:"Latte",category:"ESPRESSO_DRINK"},
     {id:"latte-large",name:"Latte 16 oz",base_name:"Latte",category:"ESPRESSO_DRINK"},
     {id:"tea",name:"Tea",base_name:null,category:"TEA"},
     {id:"sandwich",name:"Sandwich",base_name:null,category:"FOOD"}],
   savedEvents:[event],monitors:[monitor],verifiedBinding:true,followupPermitted:true,
   ...overrides};
}
describe("Meta's seven ordered daily-brief values",()=>{
 it("uses covered drinks, groups sizes and retains canonical net sales, event and local weekday",()=>{
   const result=prepareMorningBrief(evidence(),now);
   expect(result).toEqual({netSalesCents:240000,parameters:["Café One","€2,400.00","11","Latte","9",
     "Halloween festival at Moscone Center at 15:00","Saturday"],
     businessDate:"2026-10-30",today:"2026-10-31",
     provenance:{sales:"daily_rollups",items:"menu_item_quantities_sold",menu:"menu_items",
       eventId:"event-1",monitorProposalId:"monitor-1"}});
 });
 it("skips missing, partial and unverified closed-day numbers, including missing currency",()=>{
   for(const variant of [
     {netSalesCents:null},{netSalesCents:NaN},{salesStatus:"missing"},
     {salesStatus:null},{currency:null},{currency:"???"},{itemCoverage:false},
     {soldItems:[]},{soldItems:[{id:"absent",units:12}]},
     {soldItems:[{id:"tea",units:0}]},{soldItems:[{id:"tea",units:0.5}]},
     {menu:[{id:"tea",name:"Tea",base_name:null,category:"unclassified"}]},
   ])expect(prepareMorningBrief(evidence(variant as Partial<MorningBriefEvidence>),now)).toBeNull();
   expect(prepareMorningBrief(evidence({netSalesCents:0}),now)?.parameters[1]).toBe("€0.00");
 });
 it("does not infer weekday monitoring from any unrelated or draft experiment",()=>{
   for(const monitors of [
     [],[{...monitor,status:"draft"}],[{...monitor,monitor_spec:{metricScope:"event",durationDays:7}}],
     [{...monitor,monitor_spec:{metricScope:"same_weekday_sales",durationDays:1}}],
     [{...monitor,monitoring_start_date:"2026-11-01"}],
   ])expect(prepareMorningBrief(evidence({monitors}),now)).toBeNull();
   expect(prepareMorningBrief(evidence({verifiedBinding:false}),now)).toBeNull();
   expect(prepareMorningBrief(evidence({followupPermitted:false}),now)).toBeNull();
 });
 it("skips unsourced, cancelled, stale, failed or out-of-day events, not predicting impact",()=>{
   for(const savedEvents of [
     [],[{...event,status:"cancelled" as const}],[{...event,lastVerifiedAt:null}],
     [{...event,sourceUrl:null}],[{...event,verificationFailedAt:"2026-10-31T01:00:00Z"}],
     [{...event,startDate:"2026-11-01",endDate:"2026-11-01"}],
     [{...event,lastVerifiedAt:"2026-10-20T00:00:00Z"}],
   ])expect(prepareMorningBrief(evidence({savedEvents}),now)).toBeNull();
 });
 it("sanitizes owner-facing provider fields and rejects excessively long values",()=>{
   const result=prepareMorningBrief(evidence({businessName:"Café  *One*\n  <hello>",
     savedEvents:[{...event,name:"Halloween\n *Festival*"}]}),now);
   expect(result?.parameters[0]).toBe("Café One hello");
   expect(result?.parameters[5]).toBe("Halloween Festival at Moscone Center at 15:00");
   expect(prepareMorningBrief(evidence({businessName:"A".repeat(121)}),now)).toBeNull();
 });
 it("uses the local business day through DST boundaries, not the UTC weekday",()=>{
   const shifted=evidence({today:"2026-11-01",yesterday:"2026-10-31",
     savedEvents:[{...event,startDate:"2026-11-01",endDate:"2026-11-01",
       lastVerifiedAt:"2026-11-01T15:30:00Z"}],
     monitors:[{...monitor,monitoring_start_date:"2026-10-31"}]});
   expect(prepareMorningBrief(shifted,new Date("2026-11-01T16:00:00Z"))?.parameters[6]).toBe("Sunday");
   expect(prepareMorningBrief({...shifted,today:"2026-11-02"},new Date("2026-11-02T16:00:00Z"))).toBeNull();
 });
});
