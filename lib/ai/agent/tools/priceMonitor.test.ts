import {describe,it,expect,vi} from "vitest";
import {priceMonitorTools} from "./priceMonitor";
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
});
