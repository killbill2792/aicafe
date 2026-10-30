import {describe,it,expect,vi,beforeEach} from "vitest";

const calls:string[]=[];
const peak=vi.fn();
vi.mock("@/lib/ai/conversations/auth.server",async(original)=>({...await original<typeof import("@/lib/ai/conversations/auth.server")>(),
  authenticatedConversationContext:vi.fn(async()=>{calls.push("auth");return {scope:{businessId:"cafe-1",ownerUserId:"u"}};})}));
const access=vi.fn();
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:(id:string)=>{calls.push("access:"+id);return access(id);}}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:vi.fn(async()=>({}))}));
vi.mock("@/lib/ai/cafeTools.server",()=>({
  readSupervisorCafeIdentity:vi.fn(async()=>({asOf:"2026-10-30",timezone:"America/Chicago",currency:"USD"})),
  createAuthenticatedCafeTools:vi.fn(async()=>({
    getSalesTrend:async()=>({available:false,value:null,quality:{missingInputs:[]}}),
    getPeakHours:async()=>peak()
  }))}));
vi.mock("@/lib/ownerFacts/store.server",()=>({loadOwnerFacts:vi.fn(async()=>[])}));
vi.mock("@/lib/data/cafeLocation.server",()=>({readCafeLocation:vi.fn(async()=>({label:"Austin, TX",city:"Austin",region:"TX",
  postalCode:null,countryCode:"US",source:"profile"}))}));
const search=vi.fn(async()=>({available:true as const,events:[]}));
vi.mock("@/lib/events/nearbyEventsSearch.server",()=>({searchNearbyEvents:(...a:unknown[])=>{calls.push("search");return search(...(a as []));}}));

import {GET} from "./route";
import {ConversationApiError} from "@/lib/ai/conversations/auth.server";
const req=()=>new Request("http://x/api/events/outlook?locale=en");

describe("Coming up endpoint",()=>{
  beforeEach(()=>{
    calls.length=0;access.mockReset();search.mockClear();
    peak.mockReset().mockResolvedValue({available:false,value:null,
      quality:{level:"low",missingInputs:["noHourlySalesFacts"],estimatedInputs:[],staleInputs:[]}});
  });
  it("never runs the paid search for a café without AI access",async()=>{
    access.mockRejectedValue(new ConversationApiError(403,"access_expired"));
    const res=await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({error:"access_expired"});
    expect(search).not.toHaveBeenCalled();
  });
  it("returns hourly facts with partial-import warnings instead of hiding incompleteness",async()=>{
    access.mockResolvedValue(undefined);
    peak.mockResolvedValue({available:true,value:{hours:[
      {date:"2026-10-03",hourLocal:14,netSalesCents:1100,locationId:null,ordersCount:1},
      {date:"2026-10-10",hourLocal:14,netSalesCents:1200,locationId:null,ordersCount:1},
      {date:"2026-10-17",hourLocal:14,netSalesCents:1300,locationId:null,ordersCount:1},
      {date:"2026-10-24",hourLocal:14,netSalesCents:1400,locationId:null,ordersCount:1}
    ]},quality:{level:"medium",missingInputs:["toastImportIncompleteDays"],
      estimatedInputs:[],staleInputs:[],notes:["hourly import partial"]}});
    const res=await GET(req());
    expect(res.status).toBe(200);
    const body=await res.json();
    expect(body.days[1].usualHourlySales).toEqual([{hourLocal:14,typicalCents:1250,sampleDays:4}]);
    expect(body.hourlySalesQuality.missingInputs).toEqual(["toastImportIncompleteDays"]);
    expect(body.notCovered).toEqual(expect.arrayContaining(["toastImportIncompleteDays","hourly import partial"]));
  });

  it("checks access first, then builds the outlook",async()=>{
    access.mockResolvedValue(undefined);
    const res=await GET(req());
    expect(res.status).toBe(200);
    expect(calls.slice(0,2)).toEqual(["auth","access:cafe-1"]);
    expect(calls).toContain("search");
    const body=await res.json();
    expect(body.days[1]).toMatchObject({date:"2026-10-31",holidays:[{name:"Halloween"}],usualHourlySales:[]});
    expect(body.days[1]).not.toHaveProperty("notable");
    expect(body.days[1]).not.toHaveProperty("decision");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
