import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";
const checks=vi.hoisted(()=>({permission:vi.fn(),entitlement:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:checks.entitlement}));
vi.mock("./access.server",()=>({assertExternalAccess:checks.permission,WEB_RESOURCE:"public"}));
import {ownerPublicWebFetch,ownerPublicWebSearch,withOwnerPublicWebScope}
  from "./publicWeb.server";
import {searchWeb} from "@/lib/ai/agent/webSearch.server";
import {searchNearbyEvents,clearNearbyEventsCache} from "@/lib/events/nearbyEventsSearch.server";
import {createCitySourceResearch} from "@/lib/events/citySourceResearch.server";
import {researchNeighborhood} from "@/lib/events/neighborhoodResearch.server";
import {enrichCityEventFact} from "@/lib/events/cityEventEnrichment.server";
import {verifyEventSource} from "@/lib/events/eventVerification.server";

const owner={businessId:"cafe-a",ownerUserId:"owner-a"};
const other={businessId:"cafe-b",ownerUserId:"owner-b"};
const address={label:"12 Market Street, San Francisco, CA 94103, US",
  city:"San Francisco",region:"CA",countryCode:"US"};
const nearby={location:address.label,city:address.city,region:address.region,
  countryCode:null,from:"2026-11-03",to:"2026-11-03"};
const event:CafeEvent={id:"00000000-0000-4000-8000-000000000011",name:"Parade",
  kind:"parade",startDate:"2026-11-03",endDate:"2026-11-03",startTime:null,endTime:null,
  venue:null,venueAddress:null,areaLabel:null,sourceUrl:"https://city.example/parade",
  status:"found",foundAt:"2026-11-01T00:00:00Z",lastCheckedAt:"2026-11-01T00:00:00Z"};
const transport=vi.fn(async()=>new Response("",{status:503}));
const entrypoints:Array<()=>Promise<unknown>>=[
  ()=>searchWeb("parade details"),
  ()=>searchNearbyEvents(nearby),
  ()=>createCitySourceResearch({maxSearches:2})({city:address.city,region:address.region,countryCode:address.countryCode,
    sources:[{id:"civic",kind:"venue",name:"Official calendar",officialUrl:"https://city.example/calendar"}],
    window:{from:nearby.from,to:nearby.to,reason:"new_day"}}),
  ()=>researchNeighborhood({address,scopes:["campus_and_conventions"]}),
  ()=>enrichCityEventFact({city:address.city,region:address.region,countryCode:address.countryCode,
    name:event.name,startDate:event.startDate,sourceUrl:event.sourceUrl!}),
  ()=>verifyEventSource(event),
];
beforeEach(()=>{
  checks.permission.mockReset().mockResolvedValue(0);checks.entitlement.mockReset().mockResolvedValue(undefined);
  transport.mockReset().mockImplementation(async()=>new Response("",{status:503}));
  clearNearbyEventsCache();vi.stubEnv("OPENAI_API_KEY","offline-test-only");vi.stubGlobal("fetch",transport);
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe("shared owner-scoped live web transport boundary",()=>{
  it("fails closed for every production web entrypoint without a bound owner",async()=>{
    await Promise.allSettled(entrypoints.map(run=>run()));
    expect(transport).not.toHaveBeenCalled();
  });
  it("blocks every production web entrypoint for revocation and permission read uncertainty",async()=>{
    for(const code of ["public_web_access_revoked","external_access_unavailable"]){
      checks.permission.mockRejectedValue(new Error(code));
      await Promise.allSettled(entrypoints.map(run=>withOwnerPublicWebScope(owner,run)));
      expect(transport).not.toHaveBeenCalled();
      expect(checks.permission).toHaveBeenCalledWith(owner,"public_web","public");
    }
  });
  it("allows actual transport for each permitted path (offline responses only)",async()=>{
    for(const run of entrypoints){
      transport.mockClear();
      await Promise.allSettled([withOwnerPublicWebScope(owner,run)]);
      expect(transport.mock.calls.length).toBeGreaterThan(0);
    }
  });
  it("rechecks before a retry rather than reusing permission observed before the first request",async()=>{
    transport.mockImplementationOnce(async()=>{
      checks.permission.mockRejectedValue(new Error("public_web_access_revoked"));
      return new Response("",{status:503});
    });
    await withOwnerPublicWebScope(owner,()=>searchNearbyEvents(nearby));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(checks.permission.mock.calls.length).toBeGreaterThan(1);
  });
  it("isolates concurrent owners and does not leak the scope after completion",async()=>{
    checks.permission.mockImplementation(async scope=>{
      await Promise.resolve();
      if(scope.businessId===owner.businessId)throw Error("public_web_access_revoked");
      return 0;
    });
    const blocked=withOwnerPublicWebScope(owner,()=>ownerPublicWebFetch("https://example.invalid/blocked"));
    const allowed=withOwnerPublicWebScope(other,()=>ownerPublicWebFetch("https://example.invalid/allowed"));
    const results=await Promise.allSettled([blocked,allowed]);
    expect(results.map(x=>x.status)).toEqual(["rejected","fulfilled"]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith("https://example.invalid/allowed",undefined);
    await expect(ownerPublicWebFetch("https://example.invalid/unscoped")).rejects.toThrow("permissionsUnavailable");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("returns the same explicit permission status for scheduled and interactive hosted searches",async()=>{
    checks.permission.mockRejectedValueOnce(Error("public_web_access_revoked"))
      .mockRejectedValueOnce(Error("external_access_unavailable"));
    const lookup=vi.fn(()=>searchWeb("untrusted page"));
    expect(await ownerPublicWebSearch(owner,lookup)).toEqual({available:false,reason:"permissionDenied"});
    expect(await ownerPublicWebSearch(owner,lookup)).toEqual({available:false,reason:"permissionsUnavailable"});
    expect(lookup).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
  });
});
