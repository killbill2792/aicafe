import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({owner:vi.fn(),capture:vi.fn()}));
vi.mock("@/lib/pos/toast/ownerAccess",()=>({authorizeToastOwner:mocks.owner}));
vi.mock("@/lib/pos/toast/rawSample.server",()=>({captureToastRawSample:mocks.capture}));
import {POST} from "./route";
const businessId="11111111-1111-4111-8111-111111111111";
const req=()=>new Request("https://example.test/api/pos/toast/raw-sample",{
 method:"POST",headers:{"content-type":"application/json"},
 body:JSON.stringify({businessId,businessDate:"2026-10-20"})
});
beforeEach(()=>{mocks.owner.mockReset().mockResolvedValue({});
 mocks.capture.mockReset().mockResolvedValue({captured:10,skipped:false,failed:0});});
describe("Toast raw diagnostic owner route",()=>{
 it("denies non-owners and never invokes the capture",async()=>{
  mocks.owner.mockResolvedValue(null);
  const response=await POST(req());
  expect(response.status).toBe(403);
  expect(mocks.capture).not.toHaveBeenCalled();
 });
 it("rejects invalid payloads before ownership or capture",async()=>{
  const response=await POST(new Request("https://example.test/api/pos/toast/raw-sample",{
   method:"POST",headers:{"content-type":"application/json"},body:'{"businessId":"bad"}'
  }));
  expect(response.status).toBe(400);
  expect(mocks.owner).not.toHaveBeenCalled();
 });
 it("calls capture only for the authenticated tenant",async()=>{
  const response=await POST(req());
  expect(response.status).toBe(200);
  expect(mocks.owner).toHaveBeenCalledWith(businessId);
  expect(mocks.capture).toHaveBeenCalledWith(businessId,"2026-10-20",expect.anything(),240_000);
 });
 it("returns distinct HTTP codes and error identifiers for each outcome",async()=>{
  const outcomes=[
   {reason:"cooldown",code:429,failed:0},
   {reason:"busy",code:409,failed:0},
   {reason:"no_location",code:404,failed:0},
   {reason:"db_error",code:503,failed:1},
   {reason:"invalid_request",code:400,failed:0},
   {reason:"missing_hash_key",code:503,failed:0},
   {reason:"lease_lost",code:503,failed:1},
   {reason:"partial",code:206,failed:0},
  ] as const;
  for(const {reason,code,failed} of outcomes){
   mocks.capture.mockResolvedValueOnce({captured:0,skipped:true,failed,reason});
   const res=await POST(req());
   expect(res.status).toBe(code);
   expect((await res.json()).error).toBe(reason);
  }
 });
});
