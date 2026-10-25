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
import type {PosAdapter} from "./types";
import type {SupabaseClient} from "@supabase/supabase-js";
afterEach(()=>{vi.useRealTimers();spies.recompute.mockReset();spies.eligible.mockReset();});
function db(){
  const seen:string[]=[];
  const from=(table:string)=>{
    seen.push(table);
    const chain={select:()=>chain,eq:()=>chain,is:()=>chain,
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
