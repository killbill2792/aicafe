import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {currentToastBusinessDay} from "./todaySoFar";
import {readToastTodaySoFar,clearTodaySoFarCache} from "./todaySoFar.server";
import {executeAgentTool,schemas,type AgentToolContext} from "@/lib/ai/agent/tools";

const business="aaaaaaaa-0000-4000-8000-000000000001";
const r1="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const r2="bbbbbbbb-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const zone="America/Los_Angeles";
// 10:00 local on 29 October.
const now=new Date("2026-10-29T17:00:00Z");

let n=0;
function order(amount:number,opts:{status?:string;guid?:string;modified?:string;item?:string}={}){
  n++;
  const guid=opts.guid??`cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12,"0")}`;
  return {guid,businessDate:20261029,openedDate:"2026-10-29T09:00:00.000-0700",
    modifiedDate:opts.modified??"2026-10-29T16:00:00.000+0000",
    checks:[{guid:`dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12,"0")}`,
      paymentStatus:opts.status??"CLOSED",amount,taxAmount:0,payments:[],
      selections:[{guid:`eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12,"0")}`,quantity:1,price:amount,
        displayName:opts.item??"Latte"}]}]};
}
function db(mappings:unknown[]){
  const q={select:()=>q,eq:()=>q,not:async()=>({data:mappings,error:null})};
  return {from:()=>q} as unknown as SupabaseClient;
}
const mapping=(guid:string)=>({restaurant_guid:guid,toast_time_zone:zone,closeout_hour:4});

describe("today so far (live, provisional, never stored)",()=>{
  beforeEach(()=>clearTodaySoFarCache());

  it("uses the previous day before the closeout hour",()=>{
    expect(currentToastBusinessDay(new Date("2026-10-29T10:00:00Z"),zone,4)).toBe("2026-10-28");
    expect(currentToastBusinessDay(new Date("2026-10-29T12:00:00Z"),zone,4)).toBe("2026-10-29");
  });

  it("sums open and closed checks across locations and keeps the latest order revision",async()=>{
    const same="cccccccc-cccc-4ccc-8ccc-999999999999";
    const request=vi.fn(async(path:string,guid:string)=>{
      expect(path).toContain("businessDate=20261029");
      return guid===r1
        ?[order(4.5),order(5,{status:"OPEN",item:"Mocha"}),
          order(3,{guid:same,modified:"2026-10-29T15:00:00.000+0000"}),
          order(6,{guid:same,modified:"2026-10-29T16:30:00.000+0000"})]
        :[order(4.5)];
    });
    const read=await readToastTodaySoFar(db([mapping(r1),mapping(r2)]),business,now,request);
    expect(read.available).toBe(true);
    if(!read.available)return;
    expect(read.value).toMatchObject({provisional:true,businessDate:"2026-10-29",
      netSalesCents:450+500+600+450,orders:4,openChecks:1,locationsRead:2,locationsFailed:0,truncated:false});
    expect(read.value.topItems[0]).toEqual({name:"Latte",quantity:3,netSalesCents:1500});
  });

  it("reports a failed location instead of silently dropping its sales",async()=>{
    const request=vi.fn(async(_p:string,guid:string)=>{
      if(guid===r2)throw new Error("token secret");
      return [order(4)];
    });
    const read=await readToastTodaySoFar(db([mapping(r1),mapping(r2)]),business,now,request);
    expect(read).toMatchObject({available:true,value:{netSalesCents:400,locationsFailed:1}});
  });

  it("stops at the page limit and says the read is truncated",async()=>{
    const full=Array.from({length:100},()=>order(1));
    const request=vi.fn(async()=>full);
    const read=await readToastTodaySoFar(db([mapping(r1)]),business,now,request);
    expect(request).toHaveBeenCalledTimes(10);
    expect(read).toMatchObject({available:true,value:{truncated:true}});
  });

  it("is unavailable for a café without a verified Toast location",async()=>{
    expect(await readToastTodaySoFar(db([]),business,now,vi.fn()))
      .toEqual({available:false,missing:["todayLiveNoToastLocation"]});
  });

  it("caches a complete read for a few minutes so repeated questions do not hit Toast",async()=>{
    const request=vi.fn(async()=>[order(2)]);
    await readToastTodaySoFar(db([mapping(r1)]),business,now,request);
    await readToastTodaySoFar(db([mapping(r1)]),business,new Date(now.getTime()+60_000),request);
    expect(request).toHaveBeenCalledTimes(1);
    await readToastTodaySoFar(db([mapping(r1)]),business,new Date(now.getTime()+4*60_000),request);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("get_today_so_far chat tool",()=>{
  const ctx=(readTodaySoFar?:AgentToolContext["readTodaySoFar"])=>({asOf:"2026-10-29",timezone:zone,locale:"en",
    tools:{},readTodaySoFar} as unknown as AgentToolContext);

  it("is offered to the model with an empty strict schema",()=>{
    expect(Object.hasOwn(schemas,"get_today_so_far")).toBe(true);
  });

  it("labels the answer provisional and names gaps",async()=>{
    const result=await executeAgentTool("get_today_so_far",{},ctx(async()=>({available:true,value:{
      provisional:true,businessDate:"2026-10-29",readAt:now.toISOString(),netSalesCents:12_345,
      grossSalesCents:12_345,discountsCents:0,refundsCents:0,tipCents:0,orders:20,openChecks:2,
      unparsedOrders:1,topItems:[],locationsRead:1,locationsFailed:1,truncated:true}})));
    expect(result).toMatchObject({source:"today_live",provisional:true,netSalesCents:12_345,
      period:{from:"2026-10-29",to:"2026-10-29"},
      missing:["todayLiveLocationsFailed:1","todayLiveTruncated","todayLiveUnparsedOrders:1"]});
  });

  it("says why when there is no live reader or the read fails",async()=>{
    expect((await executeAgentTool("get_today_so_far",{},ctx())).missing).toEqual(["todayLiveReaderUnavailable"]);
    expect((await executeAgentTool("get_today_so_far",{},ctx(async()=>{throw new Error("x");}))).missing)
      .toEqual(["todayLiveReadFailed"]);
  });
});
