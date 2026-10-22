import { describe,expect,it,vi } from "vitest";
import { GET } from "./route";
vi.mock("@/lib/initiatives/monitor.server",()=>({
  monitorInitiatives:vi.fn(async()=>({checked:0,sampled:0,updates:0,failed:0})),
}));
describe("initiatives monitor cron auth",()=>{
  it("rejects no bearer, wrong bearer and missing configured secret",async()=>{
    process.env.CRON_SECRET="test-secret";
    for(const token of [null,"Bearer wrong","test-secret"]){
      const headers=token?{authorization:token}:{};
      const response=await GET(new Request("https://example.com/api/cron/initiatives-monitor",{headers}));
      expect(response.status).toBe(401);
    }
    delete process.env.CRON_SECRET;
    const response=await GET(new Request("https://example.com/api/cron/initiatives-monitor",{
      headers:{authorization:"Bearer undefined"}}));
    expect(response.status).toBe(401);
  });
  it("allows exact configured bearer",async()=>{
    process.env.CRON_SECRET="test-secret";
    const result=await GET(new Request("https://example.com/api/cron/initiatives-monitor",{
      headers:{authorization:"Bearer test-secret"}}));
    expect(result.status).toBe(200);
  });
});
