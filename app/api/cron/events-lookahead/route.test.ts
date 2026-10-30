import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
const run=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/events/eventsLookahead.server",()=>({runEventsLookahead:run}));
import {GET} from "./route";

describe("cron-only events lookahead authentication and rollout gate",()=>{
 const oldSecret=process.env.CRON_SECRET;
 const oldFlag=process.env.EVENTS_LOOKAHEAD_ENABLED;
 beforeEach(()=>{
  process.env.CRON_SECRET="test-secret";
  process.env.EVENTS_LOOKAHEAD_ENABLED="true";
  run.mockReset().mockResolvedValue({checked:1,scanned:2,planned:1,skipped:0,failed:0});
 });
 afterEach(()=>{
  if(oldSecret===undefined)delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET=oldSecret;
  if(oldFlag===undefined)delete process.env.EVENTS_LOOKAHEAD_ENABLED;
  else process.env.EVENTS_LOOKAHEAD_ENABLED=oldFlag;
 });
 it("rejects anonymous or wrong bearer without starting paid work",async()=>{
  const missing=await GET(new Request("https://example.org/api/cron/events-lookahead"));
  const wrong=await GET(new Request("https://example.org/api/cron/events-lookahead",{
    headers:{authorization:"Bearer wrong"},
  }));
  expect(missing.status).toBe(401);
  expect(wrong.status).toBe(401);
  expect(run).not.toHaveBeenCalled();
 });
 it("stays default-off until the reviewed migration and rollout are approved",async()=>{
  delete process.env.EVENTS_LOOKAHEAD_ENABLED;
  const response=await GET(new Request("https://example.org/api/cron/events-lookahead",{
    headers:{authorization:"Bearer test-secret"},
  }));
  expect(response.status).toBe(503);
  expect(run).not.toHaveBeenCalled();
 });
 it("runs on a matching cron bearer only after enablement",async()=>{
  const response=await GET(new Request("https://example.org/api/cron/events-lookahead",{
    headers:{authorization:"Bearer test-secret"},
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({scanned:2,planned:1});
  expect(run).toHaveBeenCalledTimes(1);
 });
 it("returns a safe failure without leaking prompts or café addresses",async()=>{
  run.mockRejectedValue(new Error("private café location"));
  const response=await GET(new Request("https://example.org/api/cron/events-lookahead",{
    headers:{authorization:"Bearer test-secret"},
  }));
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("private café");
 });
});
