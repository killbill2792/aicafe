import {describe,it,expect,vi,afterEach} from "vitest";
vi.mock("server-only",()=>({}));
const spies=vi.hoisted(()=>({recompute:vi.fn(),eligible:vi.fn()}));
vi.mock("./rollup",()=>({recomputeDailyRollup:spies.recompute}));
vi.mock("./salesFactRollups",()=>({rebuildSalesFactRollups:vi.fn()}));
vi.mock("./syncCatalog",()=>({syncCanonicalCatalog:vi.fn()}));
vi.mock("./processingFees",()=>({
  connectedActualFactFromOrders:()=>null,
  setProcessingFeeCandidateEligibility:spies.eligible,
  upsertProcessingFeeDailyFact:vi.fn(),
}));
import {syncPosData} from "./sync";
import {syncCanonicalCatalog} from "./syncCatalog";
import type {PosAdapter,PosOrder} from "./types";
import type {SupabaseClient} from "@supabase/supabase-js";
afterEach(()=>{vi.useRealTimers();spies.recompute.mockReset();spies.eligible.mockReset();});
function db(){
  const seen:string[]=[];
  const rpc=vi.fn(async()=>({data:null,error:null}));
  const from=(table:string)=>{
    seen.push(table);
    const chain={select:()=>chain,eq:()=>chain,is:()=>chain,upsert:()=>chain,
       single:async()=>({data:{id:"order-1-db"},error:null}),
      then:(ok:(value:{data:unknown[];error:null})=>unknown)=>Promise.resolve({data:[],error:null}).then(ok)};
    return chain;
  };
  return {client:{from,rpc} as unknown as SupabaseClient,seen,rpc};
}
function adapter():PosAdapter{
  return {provider:"square",fetchOrders:async()=>[],fetchCatalogItems:async()=>[],
    fetchEmployees:async()=>[],fetchTimecards:async()=>[]};
}
describe("Successful Square sync persists proven zero-order business dates",()=>{
  it("recomputes zero-orders prior full day as explicit actual without inventing orders",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-12T19:00:00Z"));
    const {client,seen}=db();
    const result=await syncPosData(client,{businessId:"b",locationId:"l",
      timezone:"America/Los_Angeles",adapter:adapter(),
      since:new Date("2026-10-11T07:00:00Z"),until:new Date("2026-10-12T07:00:00Z")});
    expect(result).toMatchObject({ordersSynced:0,timecardsSynced:0,affectedDates:["2026-10-11"]});
    expect(spies.recompute).toHaveBeenCalledWith(client,"b","2026-10-11",{salesDataStatus:"actual"});
    expect(seen).not.toContain("order_lines");
  });
  it("marks current-day zero as actual SO FAR through a successful from-midnight sync",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-12T19:00:00Z"));
    const {client}=db();
    await syncPosData(client,{businessId:"b",locationId:"l",timezone:"America/Los_Angeles",
      adapter:adapter(),since:new Date("2026-10-12T07:00:00Z"),
      until:new Date("2026-10-12T18:40:00Z")});
    expect(spies.recompute).toHaveBeenCalledWith(client,"b","2026-10-12",{salesDataStatus:"actual"});
  });
});

describe("Optional Square schedule resilience",()=>{
 it("imports covered sales even when optional scheduling access fails without leaking provider details",async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-12T19:00:00Z"));
  const {client}=db(),a=adapter();
  a.fetchPosScheduledShifts=async()=>{throw new Error("Square 403 private-provider-response")};
  const warning=vi.spyOn(console,"warn").mockImplementation(()=>{});
  try{
   const result=await syncPosData(client,{businessId:"b",locationId:"l",
    timezone:"America/Los_Angeles",adapter:a,
    since:new Date("2026-10-11T07:00:00Z"),until:new Date("2026-10-12T07:00:00Z")});
   expect(result.scheduledShiftsStatus).toBe("unavailable");
   expect(spies.recompute).toHaveBeenCalledWith(client,"b","2026-10-11",{salesDataStatus:"actual"});
   expect(JSON.stringify(warning.mock.calls)).not.toContain("private-provider-response");
  }finally{warning.mockRestore();}
 });
 it("records published shifts separately and never turns them into paid timecards",async()=>{
  const {client,seen}=db(),a=adapter();
  a.fetchPosScheduledShifts=async()=>[{externalShiftId:"shift",externalEmployeeId:"staff",
   externalJobId:null,scheduledStart:"2026-10-11T12:00:00Z",
   scheduledEnd:"2026-10-11T18:00:00Z",deleted:false}];
  const result=await syncPosData(client,{businessId:"b",locationId:"l",
   timezone:"America/Los_Angeles",adapter:a,
   since:new Date("2026-10-11T07:00:00Z"),until:new Date("2026-10-12T07:00:00Z")});
  expect(result.scheduledShiftsStatus).toBe("synced");
  expect(seen).toContain("pos_scheduled_shifts");
  expect(result.timecardsSynced).toBe(0);
 });
 it("passes no-archive protection to the catalog for multiple Square locations",async()=>{
  const {client}=db(),a=adapter();
  await syncPosData(client,{businessId:"b",locationId:"l",
   timezone:"America/Los_Angeles",adapter:a,allowCatalogArchive:false,
   since:new Date("2026-10-11T07:00:00Z"),until:new Date("2026-10-12T07:00:00Z")});
  expect(vi.mocked(syncCanonicalCatalog)).toHaveBeenCalledWith(client,"b",a,{archiveMissing:false});
 });
});

describe("Atomic POS order-line replacement",()=>{
 it("uses one scoped transactional RPC; never deletes prior lines outside the transaction",async()=>{
  const {client,seen,rpc}=db(),a=adapter();
  const order:PosOrder={
   posOrderId:"pos-o1",posLocationId:"pos-l1",closedAt:"2026-10-11T17:00:00Z",
   grossSalesCents:850,discountsCents:0,refundsCents:0,taxCents:0,tipCents:0,
   processingFeeCents:0,processingFeeStatus:"missing",netSalesCents:850,
   lines:[{posItemId:"pos-item",name:"Latte",quantity:1,netSalesCents:850,
     modifiers:[],voided:false,voidedBy:null}]
  };
  a.fetchOrders=async()=>[order];
  await syncPosData(client,{businessId:"cafe-a",locationId:"l",timezone:"America/Los_Angeles",
   adapter:a,since:new Date("2026-10-11T07:00:00Z"),
   until:new Date("2026-10-12T07:00:00Z")});
  expect(rpc).toHaveBeenCalledWith("pos_replace_order_lines",{
   p_business_id:"cafe-a",p_order_id:"order-1-db",
   p_lines:[{pos_item_id:"pos-item",menu_item_id:null,name:"Latte",quantity:1,
    net_sales_cents:850,modifiers:[],voided:false,voided_by:null,category:null}]
  });
  expect(seen).not.toContain("order_lines");
 });
});
