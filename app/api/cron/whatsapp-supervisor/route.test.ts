import {beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({bearer:vi.fn(),worker:vi.fn()}));
vi.mock("@/lib/security/bearer",()=>({verifyBearer:m.bearer}));
vi.mock("@/lib/whatsapp/supervisor-bridge.server",()=>({runWhatsAppSupervisorWorker:m.worker}));
import {GET} from "./route";
const req=()=>new Request("https://example.test/api/cron/whatsapp-supervisor");
describe("retired WhatsApp conversational Supervisor scheduler",()=>{
 beforeEach(()=>{vi.clearAllMocks();});
 it("rejects unauthorized requests",async()=>{
  m.bearer.mockReturnValue(false);expect((await GET(req())).status).toBe(401);
  expect(m.worker).not.toHaveBeenCalled();
 });
 it("cannot be reactivated by stale configuration",async()=>{
  m.bearer.mockReturnValue(true);vi.stubEnv("WHATSAPP_WORKER_ENABLED","true");
  vi.stubEnv("WHATSAPP_SUPERVISOR_ENABLED","true");
  try {const res=await GET(req());expect(res.status).toBe(410);
   expect(await res.json()).toEqual({error:"retired"});expect(m.worker).not.toHaveBeenCalled();}
  finally{vi.unstubAllEnvs();}
 });
});
