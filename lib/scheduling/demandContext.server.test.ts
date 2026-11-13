import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({owner:vi.fn(),peak:vi.fn(),factory:vi.fn()}));
vi.mock("./foundation.server",()=>({requireSchedulingOwner:mocks.owner}));
vi.mock("@/lib/data/posFactReaders.server",()=>({posFactReaders:mocks.factory}));
import {readSchedulingDemandContext} from "./demandContext.server";

const scope={businessId:"cafe-A",supabase:{name:"auth-owner-db"}};
const asOf=new Date("2026-11-20T16:00:00Z");
const call=(businessId:string,now:Date=asOf)=>readSchedulingDemandContext("2026-11-16",businessId,"America/Los_Angeles",now);
const good={available:true,value:{hours:[
 {date:"2026-11-02",hourLocal:9,locationId:"loc",ordersCount:4,netSalesCents:1000},
 {date:"2026-11-09",hourLocal:9,locationId:"loc",ordersCount:8,netSalesCents:1500},
]},quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}};
describe("Task 13a canonical demand reader boundary",()=>{
 beforeEach(()=>{
  mocks.owner.mockReset().mockResolvedValue(scope);
  mocks.peak.mockReset().mockResolvedValue(good);
  mocks.factory.mockReset().mockReturnValue({peakHours:mocks.peak});
 });
 afterEach(()=>vi.restoreAllMocks());
 it("uses only the authenticated café and existing POS peakHours reader",async()=>{
  const result=await call("cafe-A");
  expect(mocks.factory).toHaveBeenCalledExactlyOnceWith(scope.supabase,"cafe-A");
  expect(mocks.peak).toHaveBeenCalledExactlyOnceWith({from:"2026-09-21",to:"2026-11-15"});
  expect(result.status).toBe("available");
  expect(result.hours).toHaveLength(1);
  expect(result.hours[0].sampleDays).toEqual(["2026-11-02","2026-11-09"]);
 });
 it("refuses wrong café, absent owner and demo/disabled reads without touching sales",async()=>{
  expect((await call("cafe-B")).missing)
   .toEqual(["scheduleDemandUnauthorized"]);
  mocks.owner.mockResolvedValue(null);
  expect((await call("cafe-A")).status)
   .toBe("unavailable");
  expect(mocks.factory).not.toHaveBeenCalled();
 });
 it("does not provide an estimate when timecards/POS days are incomplete",async()=>{
  mocks.peak.mockResolvedValue({...good,quality:{...good.quality,
   level:"medium",missingInputs:["toastDayStatusUnavailable"]}});
  const result=await call("cafe-A");
  expect(result.hours).toEqual([]);
  expect(result.missing).toEqual(["toastDayStatusUnavailable"]);
 });
 it("fails to unavailable rather than fabricating zeros on reader error",async()=>{
  mocks.peak.mockRejectedValue(new Error("unauthorized POS"));
  const r=await call("cafe-A");
  expect(r.status).toBe("unavailable");
  expect(r.missing).toEqual(["hourlySalesUnavailable"]);
 });
 it("never requests future dates or café-local today for next week",async()=>{
  const result=await call("cafe-A",new Date("2026-11-12T18:00:00Z"));
  expect(mocks.peak).toHaveBeenCalledExactlyOnceWith({from:"2026-09-17",to:"2026-11-11"});
  expect(result.historicalPeriod.to).toBe("2026-11-11");
  expect(result.status).toBe("available");
 });
});
