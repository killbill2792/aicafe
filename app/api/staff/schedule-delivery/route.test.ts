import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({read:vi.fn(),mark:vi.fn(),preferred:vi.fn(),origin:vi.fn()}));
vi.mock("@/lib/data/ownerScheduleDelivery.server",()=>({
  DeliveryReadError:class DeliveryReadError extends Error{
    constructor(public code:string){super(code);}
  },
  readApprovedScheduleDelivery:mocks.read,
  markOwnerScheduleDelivery:mocks.mark,
  updateScheduleChannelPreference:mocks.preferred,
}));
vi.mock("@/lib/ai/conversations/http.server",()=>({
  requireSameOrigin:mocks.origin,
  readBoundedJson:(r:Request)=>r.json(),
}));
import {GET,POST,PATCH} from "./route";
import {DeliveryReadError} from "@/lib/data/ownerScheduleDelivery.server";
const req=(method:string,body:unknown)=>new Request("https://cafe.test/api/staff/schedule-delivery",{
  method,headers:{"content-type":"application/json"},body:JSON.stringify(body),
});
describe("owner schedule compose API",()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.mark.mockResolvedValue({state:"opened",channel:"whatsapp"});mocks.preferred.mockResolvedValue({channel:"sms"});});
 it("returns 404 on an unauthorized owner read, without disclosing recipients",async()=>{
  mocks.read.mockRejectedValue(new DeliveryReadError("unauthorized"));
  const result=await GET(new Request("https://cafe.test/api/staff/schedule-delivery?week=2026-11-02"));
  expect(result.status).toBe(404);
  expect(JSON.stringify(await result.json())).not.toContain("phone");
 });
 it("returns conflict when approved roster changes, without exposing an old message",async()=>{
  mocks.read.mockRejectedValue(new DeliveryReadError("schedule_changed"));
  const response=await GET(new Request("https://cafe.test/api/staff/schedule-delivery?week=2026-11-02"));
  expect(response.status).toBe(409);
  expect(JSON.stringify(await response.json())).not.toContain("message");
 });
 it("rejects stale displayed revision without recording a replacement as opened",async()=>{
  mocks.mark.mockRejectedValue(new DeliveryReadError("schedule_changed"));
  const response=await POST(req("POST",{
    week:"2026-11-02",planRevisionId:"11111111-1111-4111-8111-111111111111",
    employeeId:"22222222-2222-4222-8222-222222222222",
    channel:"sms",expectedPhone:"+14155550123"
  }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({error:"schedule_changed"});
 });
 it("records the owner-chosen channel instead of claiming actual delivery",async()=>{
  const payload={proposalId:"11111111-1111-4111-8111-111111111111",
    employeeId:"22222222-2222-4222-8222-222222222222",channel:"whatsapp",
    expectedPhone:"+14155550123"};
  const result=await POST(req("POST",payload));
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({state:"opened",channel:"whatsapp"});
  expect(mocks.mark).toHaveBeenCalledWith(payload);
  expect(mocks.origin).toHaveBeenCalled();
 });
 it("passes preferred channel updates to the owner-scoped service",async()=>{
  expect((await PATCH(req("PATCH",{employeeId:"22222222-2222-4222-8222-222222222222",channel:"sms"}))).status).toBe(200);
  expect(mocks.preferred).toHaveBeenCalled();
 });
 it("requires origin guard before a ledger write",async()=>{
  mocks.origin.mockImplementation(()=>{throw Error("bad origin");});
  expect((await POST(req("POST",{channel:"sms"}))).status).toBe(503);
  expect(mocks.mark).not.toHaveBeenCalled();
 });
});
