import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {currentToastBusinessDay,summarizeToastToday} from "./todaySoFar";
import {readToastTodaySoFar,clearTodaySoFarCache} from "./todaySoFar.server";

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
function db(mappings:unknown[],reportingTimezone:string|null=zone){
  const q={select:()=>q,eq:()=>q,not:async()=>({data:mappings,error:null})};
  const cafe={select:()=>cafe,eq:()=>cafe,
    single:async()=>({data:reportingTimezone?{timezone:reportingTimezone}:null,error:null})};
  return {from:(table:string)=>table==="businesses"?cafe:q} as unknown as SupabaseClient;
}
const mapping=(guid:string)=>({restaurant_guid:guid,toast_time_zone:zone,closeout_hour:4});

describe("today so far (live, provisional, never stored)",()=>{
  beforeEach(()=>clearTodaySoFarCache());

  it("uses the previous day before the closeout hour",()=>{
    expect(currentToastBusinessDay(new Date("2026-10-29T10:00:00Z"),zone,4)).toBe("2026-10-28");
    expect(currentToastBusinessDay(new Date("2026-10-29T12:00:00Z"),zone,4)).toBe("2026-10-29");
  });

  it("uses the reporting timezone, not Toast closeout timezone, for live hourly labels",async()=>{
    const read=await readToastTodaySoFar(db([mapping(r1)],"America/New_York"),
      business,now,async(path)=>{
        expect(path).toContain("businessDate=20261029");
        return [order(4)];
      });
    expect(read).toMatchObject({available:true,value:{
      businessDate:"2026-10-29",netSalesCents:400,
      hourlySales:[{hourLocal:12,netSalesCents:400,ordersCount:1}],
    }});
  });
  it("does not report mislabeled hourly data when the café reporting timezone is absent",async()=>{
    expect(await readToastTodaySoFar(db([mapping(r1)],null),business,now,
      async()=>[order(4)])).toEqual({
        available:false,missing:["todayLiveReportingTimezoneUnavailable"]});
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
    expect(read.value.hourlySales).toEqual([{hourLocal:9,netSalesCents:2000,ordersCount:4}]);
    expect(read.value.hourlyUnassignedOrders).toBe(0);
  });

  it("keeps a missing actual order timestamp out of hourly totals, never invents noon",async()=>{
    const unknown={...order(4),openedDate:null};
    const read=await readToastTodaySoFar(db([mapping(r1)]),business,now,
      async()=>[unknown,order(2)]);
    expect(read).toMatchObject({available:true,value:{
      netSalesCents:600,orders:2,hourlyUnassignedOrders:1,
      hourlySales:[{hourLocal:9,netSalesCents:200,ordersCount:1}],
    }});
  });
  it("combines both real occurrences of DST fall-back hour, excluding unknown timestamps",()=>{
    const fake=(guid:string,at:string,cents:number)=>({
      guid,modifiedDate:at,hourObservedAt:at,
      normalized:{netSalesCents:cents,grossSalesCents:cents,discountsCents:0,
        refundsCents:0,tipCents:0,lines:[]},openChecks:0,
    });
    const page={unparsed:[],orders:[
      fake("a","2026-11-01T08:30:00Z",100),
      fake("b","2026-11-01T09:30:00Z",-20),
    ]};
    const got=summarizeToastToday({businessDate:"2026-11-01",
      readAt:"2026-11-01T10:00:00Z",timezone:zone,
      pages:[page as never],locationsRead:1,locationsFailed:0,truncated:false});
    expect(got.hourlySales).toEqual([{hourLocal:1,netSalesCents:80,ordersCount:2}]);
    expect(got.netSalesCents).toBe(80);
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
