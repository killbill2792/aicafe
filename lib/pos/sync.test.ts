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
import type {PosAdapter} from "./types";
import type {SupabaseClient} from "@supabase/supabase-js";
afterEach(()=>{vi.useRealTimers();spies.recompute.mockReset();spies.eligible.mockReset();});
function db(){
  const seen:string[]=[];
  const from=(table:string)=>{
    seen.push(table);
    const chain={select:()=>chain,eq:()=>chain,is:()=>chain,upsert:()=>chain,
      then:(ok:(value:{data:unknown[];error:null})=>unknown)=>Promise.resolve({data:[],error:null}).then(ok)};
    return chain;
  };
  return {client:{from} as unknown as SupabaseClient,seen};
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
