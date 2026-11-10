import {describe,it,expect,vi} from "vitest";
import {priceMonitorTools,mapPriceMonitorRows,monitorCafeDate,
 planVerifiedToastPriceObservations,type VerifiedToastPriceDelta} from "./priceMonitor";
import type {OwnerProposalRow,OwnerReportRow} from "@/lib/ai/supervisor/loop/reads.server";
import type {AgentToolContext} from "./index";

const context=(readPriceMonitors?:AgentToolContext["readPriceMonitors"])=>
  ({asOf:"2026-11-03",locale:"en",timezone:"America/Los_Angeles",
    tools:{} as AgentToolContext["tools"],readPriceMonitors}) as AgentToolContext;

describe("get_price_monitor_status",()=>{
  it("reads an already scheduled price change without proposing another",async()=>{
    const monitors=[{proposalId:"proposal-1",threadId:"thread-1",productName:"Latte",
      status:"manual_confirmed",startDate:"2026-11-04",durationDays:7,day:0,
      oldPriceCents:785,newPriceCents:795,reportStatus:null}];
    const read=vi.fn().mockResolvedValue(monitors);
    const result=await priceMonitorTools.get_price_monitor_status.execute({},context(read));
    expect(read).toHaveBeenCalledOnce();
    expect(result).toMatchObject({source:"supervisor_loop",missing:[],monitors});
  });
  it("reports unavailable reader instead of claiming no monitors",async()=>{
    expect(await priceMonitorTools.get_price_monitor_status.execute({},context()))
      .toMatchObject({missing:["monitor_reader_unavailable"],monitors:[]});
  });
  it("reports failed reads instead of silently returning an empty success",async()=>{
    const read=vi.fn().mockRejectedValue(new Error("database unavailable"));
    expect(await priceMonitorTools.get_price_monitor_status.execute({},context(read)))
      .toMatchObject({missing:["monitor_read_failed"],monitors:[]});
  });
  it("maps canonical rows with café-local dates and completed reports",()=>{
    const row={id:"p1",thread_id:"t1",capability_id:"alex.menu_price_change.v1",
      revision:1,status:"manual_confirmed",
      canonical_effect_payload:{productName:"Latte",oldPriceCents:785,newPriceCents:795},
      baseline:null,monitor_spec:{durationDays:7},monitoring_start_date:"2026-11-04",
      created_at:"2026-11-03T10:00:00Z"} satisfies OwnerProposalRow;
    const report={proposal_id:"p1",status:"complete",report:{},generated_at:"2026-11-11T12:00:00Z"} satisfies OwnerReportRow;
    expect(mapPriceMonitorRows([row],[report],"2026-11-03","America/Los_Angeles")).toEqual([{
      proposalId:"p1",threadId:"t1",productName:"Latte",status:"manual_confirmed",
      stage:"scheduled",startDate:"2026-11-04",durationDays:7,day:0,
      finalReportMissing:false,finalResult:{status:"complete",recommendation:null,
        coveredDays:null,observedRevenueCents:null,realizedRevenueDifferenceCents:null,source:null},
      oldPriceCents:785,newPriceCents:795,reportStatus:"complete"
    }]);
    expect(mapPriceMonitorRows([row],[],"2026-11-04","America/Los_Angeles")[0].day).toBe(1);
    expect(mapPriceMonitorRows([row],[],"2026-11-10","America/Los_Angeles")[0].day).toBe(7);
  });
  it("uses the café timezone at UTC date boundaries",()=>{
    expect(monitorCafeDate("2026-11-04T03:00:00Z","America/Los_Angeles")).toBe("2026-11-03");
    expect(monitorCafeDate("2026-11-04T03:00:00Z","Asia/Tokyo")).toBe("2026-11-04");
    const row={id:"p1",thread_id:"t1",capability_id:"alex.menu_price_change.v1",
      revision:1,status:"committed",canonical_effect_payload:{productName:"Latte",oldPriceCents:785,newPriceCents:795},
      baseline:null,monitor_spec:{durationDays:7},monitoring_start_date:"2026-11-04",
      created_at:"2026-11-03T10:00:00Z"} satisfies OwnerProposalRow;
    expect(mapPriceMonitorRows([row],[],"2026-11-04T03:00:00Z","America/Los_Angeles")[0].day).toBe(0);
    expect(mapPriceMonitorRows([row],[],"2026-11-04T03:00:00Z","Asia/Tokyo")[0].day).toBe(1);
  });
  it("finishes an elapsed seven-day monitor with its actual final result, never day 12",()=>{
    const row={id:"price-p",thread_id:"thread-p",capability_id:"alex.drink_price_experiment.v1",
      revision:1,status:"committed",
      canonical_effect_payload:{productName:"Latte",oldPriceCents:785,newPriceCents:795},
      baseline:null,monitor_spec:{durationDays:7},monitoring_start_date:"2026-11-04",
      created_at:"2026-11-03T20:00:00Z"} satisfies OwnerProposalRow;
    const report={proposal_id:"price-p",status:"complete",
      report:{recommendation:"keep",coveredDays:7,observedRevenueCents:80000,
        realizedRevenueDifferenceCents:700,source:"order_lines"},
      generated_at:"2026-11-12T09:00:00Z"} satisfies OwnerReportRow;
    const finished=mapPriceMonitorRows([row],[report],"2026-11-15","America/Los_Angeles")[0];
    expect(finished).toMatchObject({stage:"finished",status:"committed",day:null,
      durationDays:7,reportStatus:"complete",finalReportMissing:false,
      finalResult:{status:"complete",recommendation:"keep",coveredDays:7,
        observedRevenueCents:80000,realizedRevenueDifferenceCents:700,source:"order_lines"}});
    // Before the seventh business day ends, it is still in progress.
    expect(mapPriceMonitorRows([row],[],"2026-11-10","America/Los_Angeles")[0])
      .toMatchObject({stage:"monitoring",day:7,finalReportMissing:false});
    const noReport=mapPriceMonitorRows([row],[],"2026-11-15","America/Los_Angeles")[0];
    expect(noReport).toMatchObject({stage:"finished",day:null,reportStatus:null,
      finalReportMissing:true,finalResult:null});
  });

  it("respects the café-local day boundary when a monitoring window ends",()=>{
    const row={id:"price-p",thread_id:"thread-p",capability_id:"alex.menu_price_change.v1",
      revision:1,status:"manual_confirmed",
      canonical_effect_payload:{productName:"Latte",oldPriceCents:785,newPriceCents:795},
      baseline:null,monitor_spec:{durationDays:7},monitoring_start_date:"2026-11-04",
      created_at:"2026-11-03T20:00:00Z"} satisfies OwnerProposalRow;
    expect(mapPriceMonitorRows([row],[],"2026-11-11T03:00:00Z","America/Los_Angeles")[0])
      .toMatchObject({stage:"monitoring",day:7});
    expect(mapPriceMonitorRows([row],[],"2026-11-11T09:00:00Z","America/Los_Angeles")[0])
      .toMatchObject({stage:"finished",day:null,finalReportMissing:true});
  });

});

describe("source-verified seven-day Toast price observation plan (no sends)",()=>{
 const restaurant="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
 const item="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
 const observation:VerifiedToastPriceDelta={
  businessId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",restaurantGuid:restaurant,
  menuItemId:item,posItemId:"toast:"+restaurant+":"+item,
  contextKey:"published-default",sourceType:"connected_pos",sourceProvider:"toast",
  oldPriceCents:700,newPriceCents:750,publicationVersion:"2026-11-01T08:30:00Z",
  observedAt:"2026-11-01T08:30:00Z",sourceEffectiveAt:null
 };
 it("uses exactly seven elapsed 24-hour windows across DST without invented effective time",()=>{
  const windows=planVerifiedToastPriceObservations([observation],"2026-11-09T09:30:00Z");
  expect(windows).toHaveLength(7);
  expect(windows.map(w=>w.day)).toEqual([1,2,3,4,5,6,7]);
  expect(windows[0]).toMatchObject({
   from:"2026-11-01T08:30:00.000Z",to:"2026-11-02T08:30:00.000Z",
   sourceEffectiveAt:null,coverage:"not_assessed",kind:"observational",due:true,
   interrupted:false
  });
  expect(windows[6].to).toBe("2026-11-08T08:30:00.000Z");
  expect(windows.map(w=>w.deliveryKey).filter((k,i,a)=>a.indexOf(k)===i)).toHaveLength(7);
 });
 it("never creates due notifications before the actual observed time or measured window",()=>{
  expect(planVerifiedToastPriceObservations([observation],"2026-11-01T08:00:00Z"))
   .toEqual([]);
  const windows=planVerifiedToastPriceObservations([observation],"2026-11-01T09:00:00Z");
  expect(windows).toHaveLength(7);
  expect(windows.every(w=>w.due===false)).toBe(true);
  expect(windows.every(w=>w.coverage==="not_assessed")).toBe(true);
 });
 it("preserves separate old/reverted-price exposure segments without causal claims",()=>{
  const second={...observation,oldPriceCents:750,newPriceCents:700,
   publicationVersion:"2026-11-02T20:00:00Z",
   observedAt:"2026-11-02T20:00:00Z"};
  const windows=planVerifiedToastPriceObservations(
   [second,observation],"2026-11-05T00:00:00Z");
  expect(windows.filter(w=>w.publicationVersion===observation.publicationVersion))
   .toHaveLength(2);
  expect(windows[1]).toMatchObject({day:2,interrupted:true,
   to:"2026-11-02T20:00:00.000Z",due:true});
  expect(windows.filter(w=>w.publicationVersion===second.publicationVersion))
   .toHaveLength(7);
  expect(windows[2]).toMatchObject({day:1,newPriceCents:700,
   from:"2026-11-02T20:00:00.000Z"});
 });
 it("denies cross-restaurant identity, unverified manual changes and unknown prices",()=>{
  const mismatch={...observation,restaurantGuid:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"};
  const manual={...observation,sourceType:"owner_manual"} as unknown as VerifiedToastPriceDelta;
  const unknown={...observation,oldPriceCents:0};
  expect(planVerifiedToastPriceObservations([mismatch,manual,unknown],
   "2026-11-09T09:30:00Z")).toEqual([]);
 });
 it("deduplicates repeated source-version observations and isolates café/price contexts",()=>{
  const another={...observation,contextKey:"published-breakfast"};
  const windows=planVerifiedToastPriceObservations(
   [observation,observation,another],"2026-11-09T09:30:00Z");
  expect(windows).toHaveLength(14);
  expect(new Set(windows.map(w=>w.deliveryKey)).size).toBe(14);
 });
});
