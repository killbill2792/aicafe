import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("@/lib/admin/questionPatterns.server",()=>({
  classifyPendingTurns:vi.fn(async()=>({processed:2,batches:1})),
  supabaseClassifierStore:vi.fn(()=>({})),
}));
import {GET} from "./route";
import {classifyPendingTurns} from "@/lib/admin/questionPatterns.server";
describe("admin daily cron access",()=>{
  beforeEach(()=>{process.env.CRON_SECRET="cron-test-secret";vi.clearAllMocks();});
  it("rejects absent and incorrect credentials before touching data",async()=>{
    expect((await GET(new Request("https://example.test/api/cron/admin-question-patterns"))).status).toBe(401);
    expect((await GET(new Request("https://example.test/api/cron/admin-question-patterns",{headers:{authorization:"Bearer wrong"}}))).status).toBe(401);
    expect(classifyPendingTurns).not.toHaveBeenCalled();
  });
  it("runs the classifier when authorized",async()=>{
    const response=await GET(new Request("https://example.test/api/cron/admin-question-patterns",{headers:{authorization:"Bearer cron-test-secret"}}));
    expect(response.status).toBe(200);
    expect((await response.json()).processed).toBe(2);
  });
});
