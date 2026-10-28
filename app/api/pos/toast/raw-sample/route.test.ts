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
  expect(mocks.capture).toHaveBeenCalledWith(businessId,"2026-10-20",expect.anything());
 });
 it("distinguishes DB failures from cooldowns",async()=>{
  mocks.capture.mockResolvedValueOnce({captured:0,skipped:true,failed:1});
  expect((await POST(req())).status).toBe(503);
  mocks.capture.mockResolvedValueOnce({captured:0,skipped:true,failed:0});
  expect((await POST(req())).status).toBe(429);
 });
});
