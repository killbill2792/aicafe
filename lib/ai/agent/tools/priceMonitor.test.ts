import {describe,it,expect,vi} from "vitest";
import {priceMonitorTools,mapPriceMonitorRows,monitorCafeDate} from "./priceMonitor";
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
