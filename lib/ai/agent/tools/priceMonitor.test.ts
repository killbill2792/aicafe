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
    const report={proposal_id:"p1",status:"complete",report:{},generated_at:"2026-11-11T12:00:00Z"}
      satisfies OwnerReportRow;
    expect(mapPriceMonitorRows([row],[report],"2026-11-03","America/Los_Angeles")).toEqual([{
      proposalId:"p1",threadId:"t1",productName:"Latte",status:"manual_confirmed",
      startDate:"2026-11-04",durationDays:7,day:0,
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
});
