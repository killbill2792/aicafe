import {describe,it,expect,vi,beforeEach,afterEach} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
  refresh:vi.fn(async(..._args:unknown[])=>({businessDate:"2026-10-28",alertsCreated:0})),
  calls:0,
  ownerRun:vi.fn(async()=>({processed:1,state:"completed"})),
  due:vi.fn(async()=>({scopes:1,delivered:1,failed:0})),
  enqueue:vi.fn(async()=>2),
  investigate:vi.fn(async()=>({processed:2,collected:1,investigated:1,followUps:0,failed:0})),
  routines:vi.fn(async(_db:unknown,_businessId:string,_timezone:string,_now:Date,_enqueue?:unknown)=>({routinesChecked:1,runs:1,notices:1,failed:0,evidenceChecks:1,investigationsQueued:2})),
}));
vi.mock("@/lib/security/bearer",()=>({verifyBearer:(req:Request,secret:string)=>
  req.headers.get("authorization")==="Bearer "+secret}));
vi.mock("@/lib/alerts/refreshDerived.server",()=>({refreshDerivedForBusiness:mocks.refresh,
  derivedRefreshSchemaMissing:(error:{code?:string}|null)=>error?.code==="PGRST202"}));
vi.mock("@/lib/operating/commitments.server",()=>({deliverPendingCommitments:mocks.due}));
vi.mock("@/lib/ai/supervisor/routines/dispatch.server",()=>({dispatchRoutinesForBusiness:mocks.routines}));
vi.mock("@/lib/ai/supervisor/routines/investigation.server",()=>({
  enqueueInvestigationsForOwner:mocks.enqueue,
  processDueInvestigations:mocks.investigate,
}));
vi.mock("@/lib/ai/supervisor/runs/worker.server",()=>({processOldestDurableRun:mocks.ownerRun}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({
  rpc:async()=>({data:null,error:{code:"PGRST202"}}),
  from:()=>({select(){return this},order(){return this},
    async range(){mocks.calls++;return {data:[
      {id:"a",timezone:"America/Los_Angeles",is_demo:false},
      {id:"b",timezone:"America/New_York",is_demo:false},
      {id:"demo",timezone:"UTC",is_demo:true}],error:null};}}),
})}));
import {GET} from "./route";
beforeEach(()=>{vi.stubEnv("CRON_SECRET","test-secret");vi.stubEnv("SUPERVISOR_RUN_WORKER_ENABLED","");vi.stubEnv("SUPERVISOR_DURABLE_CHAT_ENABLED","");mocks.ownerRun.mockReset().mockResolvedValue({processed:1,state:"completed"});mocks.refresh.mockClear();mocks.due.mockClear();mocks.routines.mockClear();mocks.enqueue.mockClear();mocks.investigate.mockClear();mocks.calls=0});
afterEach(()=>vi.unstubAllEnvs());
describe("refresh-derived cron",()=>{
  it("requires authorization before even fetching businesses",async()=>{
    const result=await GET(new Request("https://example.test/api/cron/refresh-derived"));
    expect(result.status).toBe(401);
    expect(mocks.calls).toBe(0);
    expect(mocks.due).not.toHaveBeenCalled();
    expect(mocks.routines).not.toHaveBeenCalled();
    expect(mocks.investigate).not.toHaveBeenCalled();
    expect(mocks.ownerRun).not.toHaveBeenCalled();
  });
  it("runs for each real café without touching the demo tenant",async()=>{
    const result=await GET(new Request("https://example.test/api/cron/refresh-derived",{
      headers:{authorization:"Bearer test-secret"},
    }));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({checked:2,refreshed:2,failed:0,
      commitments:{scopes:1,delivered:1,failed:0},
      routines:{routinesChecked:2,runs:2,notices:2,failed:0,evidenceChecks:2,investigationsQueued:4},
      investigations:{processed:2,collected:1,investigated:1,followUps:0,failed:0}});
    expect(mocks.due).toHaveBeenCalledTimes(1);
    expect(mocks.refresh.mock.calls.map(call=>call[1])).toEqual(["a","b"]);
    expect(mocks.routines.mock.calls.map(call=>call[1])).toEqual(["a","b"]);
    expect(mocks.routines.mock.calls.every(call=>call[4]===mocks.enqueue)).toBe(true);
    expect(mocks.investigate).toHaveBeenCalledOnce();
    expect(mocks.ownerRun).not.toHaveBeenCalled();
  });
  it("does not hide successful cafés when a routine fails",async()=>{
    mocks.routines.mockResolvedValueOnce({routinesChecked:0,runs:0,notices:0,failed:1,evidenceChecks:0,investigationsQueued:0})
      .mockResolvedValueOnce({routinesChecked:1,runs:1,notices:0,failed:0,evidenceChecks:0,investigationsQueued:0});
    const result=await GET(new Request("https://example.test/api/cron/refresh-derived",{
      headers:{authorization:"Bearer test-secret"},
    }));
    expect(result.status).toBe(207);
    expect(await result.json()).toMatchObject({refreshed:2,routines:{failed:1}});
  });
  it("does not activate scheduled owner work using the existing manual worker flag alone",async()=>{
    vi.stubEnv("SUPERVISOR_RUN_WORKER_ENABLED","true");
    const result=await GET(new Request("https://example.test/api/cron/refresh-derived",{
      headers:{authorization:"Bearer test-secret"},
    }));
    expect(result.status).toBe(200);
    expect(mocks.ownerRun).not.toHaveBeenCalled();
  });
  it("dispatches one bounded owner-run slice before the refresh scan, without replacing investigation dispatch",async()=>{
    vi.stubEnv("SUPERVISOR_RUN_WORKER_ENABLED","true");
    vi.stubEnv("SUPERVISOR_DURABLE_CHAT_ENABLED","true");
    mocks.ownerRun.mockImplementationOnce(async()=>{
      expect(mocks.calls).toBe(0);
      return {processed:1,state:"busy"};
    });
    const result=await GET(new Request("https://example.test/api/cron/refresh-derived",{
      headers:{authorization:"Bearer test-secret"},
    }));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ownerRuns:{processed:1,state:"busy",failed:0},refreshed:2});
    expect(mocks.ownerRun).toHaveBeenCalledOnce();
    expect(mocks.investigate).toHaveBeenCalledOnce();
  });
  it("isolates an unavailable owner worker and reports only a sanitized failure",async()=>{
    vi.stubEnv("SUPERVISOR_RUN_WORKER_ENABLED","true");
    vi.stubEnv("SUPERVISOR_DURABLE_CHAT_ENABLED","true");
    mocks.ownerRun.mockRejectedValueOnce(new Error("private tenant data"));
    const result=await GET(new Request("https://example.test/api/cron/refresh-derived",{
      headers:{authorization:"Bearer test-secret"},
    }));
    expect(result.status).toBe(207);
    const body=await result.json();
    expect(body).toMatchObject({ownerRuns:{processed:0,state:null,failed:1},refreshed:2});
    expect(JSON.stringify(body)).not.toContain("private tenant data");
    expect(mocks.investigate).toHaveBeenCalledOnce();
  });
});

describe("U1 refresh workload and lease timing",()=>{
  it("uses the actual time after a slow refresh to claim investigations, not an expired invocation timestamp",async()=>{
    vi.useFakeTimers();
    const started=new Date("2026-11-20T17:00:00Z");
    vi.setSystemTime(started);
    try{
      mocks.refresh.mockImplementationOnce(async()=>{
        vi.setSystemTime(new Date(started.getTime()+181000));
        return {businessDate:"2026-11-20",alertsCreated:0};
      });
      const result=await GET(new Request("https://example.test/api/cron/refresh-derived",{headers:{authorization:"Bearer test-secret"}}));
      expect(result.status).toBe(200);
      expect(mocks.investigate).toHaveBeenCalledOnce();
      const args=mocks.investigate.mock.calls[0] as unknown as [unknown,Date,number];
      expect(args[1].getTime()).toBeGreaterThanOrEqual(started.getTime()+181000);
    }finally{vi.useRealTimers();}
  });
  it("does not launch simultaneous full café refreshes that contend with owner work",async()=>{
    let running=0,peak=0;
    mocks.refresh.mockImplementation(async()=>{
      running++;peak=Math.max(peak,running);
      await Promise.resolve();
      running--;
      return {businessDate:"2026-11-20",alertsCreated:0};
    });
    try{
      const response=await GET(new Request("https://example.test/api/cron/refresh-derived",{headers:{authorization:"Bearer test-secret"}}));
      expect(response.status).toBe(200);
      expect(mocks.refresh).toHaveBeenCalledTimes(2);
      expect(peak).toBe(1);
    }finally{mocks.refresh.mockReset().mockResolvedValue({businessDate:"2026-10-28",alertsCreated:0});}
  });
});
