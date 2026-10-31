import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({bearer:vi.fn(),worker:vi.fn()}));
vi.mock("@/lib/security/bearer",()=>({verifyBearer:mocks.bearer}));
vi.mock("@/lib/whatsapp/supervisor-bridge.server",()=>({
 runWhatsAppSupervisorWorker:mocks.worker,
}));
import {GET} from "./route";
const req=()=>new Request("https://cafe-profit.vercel.app/api/cron/whatsapp-supervisor",{
 headers:{Authorization:"Bearer hidden-secret"},
});
describe("default-off protected WhatsApp Supervisor cron",()=>{
 beforeEach(()=>{
  vi.clearAllMocks();
  delete process.env.WHATSAPP_SUPERVISOR_ENABLED;
  delete process.env.WHATSAPP_WORKER_ENABLED;
  mocks.bearer.mockReturnValue(true);
  mocks.worker.mockResolvedValue({inbound:"done",replyQueue:{enqueued:1,skipped:0},outbound:"disabled"});
 });
 it("denies unauthorized requests before touching worker or database",async()=>{
  mocks.bearer.mockReturnValue(false);
  const res=await GET(req());
  expect(res.status).toBe(401);
  expect(mocks.worker).not.toHaveBeenCalled();
 });
 it("keeps the worker off without BOTH explicit server flags",async()=>{
  process.env.WHATSAPP_WORKER_ENABLED="true";
  expect((await GET(req())).status).toBe(503);
  expect(mocks.worker).not.toHaveBeenCalled();
  process.env.WHATSAPP_SUPERVISOR_ENABLED="true";
  delete process.env.WHATSAPP_WORKER_ENABLED;
  expect((await GET(req())).status).toBe(503);
  expect(mocks.worker).not.toHaveBeenCalled();
 });
 it("drains one signed inbound lease and reconciles verified replies only when enabled",async()=>{
  process.env.WHATSAPP_WORKER_ENABLED="true";
  process.env.WHATSAPP_SUPERVISOR_ENABLED="true";
  const res=await GET(req());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({inbound:"done",replyQueue:{enqueued:1,skipped:0},outbound:"disabled"});
  expect(mocks.worker).toHaveBeenCalledTimes(1);
 });
 it("fails closed without exposing raw server errors",async()=>{
  process.env.WHATSAPP_WORKER_ENABLED="true";
  process.env.WHATSAPP_SUPERVISOR_ENABLED="true";
  mocks.worker.mockRejectedValue(new Error("no database"));
  const res=await GET(req());
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({error:"whatsapp_worker_unavailable"});
 });
});
