import {beforeEach,afterEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
  model:vi.fn(),access:vi.fn(),tools:vi.fn(),identity:vi.fn(),
  budget:vi.fn(),notify:vi.fn(),priorities:vi.fn(),
}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:mocks.access}));
vi.mock("@/lib/ai/cafeTools.server",()=>({
  createOwnerScopedCafeTools:mocks.tools,readSupervisorCafeIdentity:mocks.identity,
}));
vi.mock("@/lib/ai/agent/loop.server",()=>({runAgentTurn:mocks.model}));
vi.mock("@/lib/ai/supervisor/runs/usage.server",()=>({withWorkerBudget:mocks.budget}));
vi.mock("@/lib/operating/notifyOwner.server",()=>({notifyOwner:mocks.notify}));
vi.mock("./dispatch.server",()=>({readActionablePriorities:mocks.priorities}));
import {enqueueInvestigationsForOwner,processNextInvestigation,processDueInvestigations}
  from "./investigation.server";
const source={kind:"sales_anomaly",status:"new",payload:{
  quality:"verified",severity:"high",
}};
const synopsis={kind:"sales_anomaly",status:"new",quality:"verified",severity:"high",
  relatedAlerts:["sales_anomaly"],relatedTasks:["data_quality"]};
const now=new Date("2026-11-14T17:00:00Z");
const base={
  business_id:"cafe-a",owner_user_id:"owner-a",thread_id:"thread-a",
  source_type:"alert",source_id:"alert-a",revision_hash:"a".repeat(64),
  stable_key:"b".repeat(64),step_version:0,lease_token:"lease-a",
};
const collected={...base,phase:"collect",evidence:{}};
const investigating={...base,phase:"investigate",step_version:1,
  evidence:{source:synopsis,collectedAt:now.toISOString()}};
const following={...base,phase:"awaiting_owner",step_version:2,
  narrative:"Previous owner-visible plan: examine wage coverage and propose an approved roster adjustment.",
  evidence:{source:synopsis,collectedAt:now.toISOString()}};
const agentResult=(patch:Record<string,unknown>={})=>({
  text:"I checked sales and labor coverage. Staffing remains uncertain. Review the owner approval card before any change; I will check again.",
  endReason:"complete",tools:["get_sales","get_labor"],unverified:[],
  results:[{source:"sales",period:null,missing:[]},
    {source:"labor",period:null,missing:["unverifiedWages"]}],
  usage:{modelCalls:2,toolCalls:2,inputTokens:100,outputTokens:100,cachedTokens:0,latencyMs:200},
  ...patch,
});
function db(claims:Record<string,unknown>[],options?:{sourceError?:boolean;sourceStatus?:string}){
  const calls:Array<{name:string;args:Record<string,unknown>}>=[];
  const client={
    rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
      calls.push({name,args});
      return {data:name==="supervisor_claim_investigation"?claims.shift()??null:true,error:null};
    }),
    from:(table:string)=>{
      const builder={
        select(){return builder},eq(){return builder},in(){return builder},
        or(){return builder},order(){return builder},
        async maybeSingle(){return options?.sourceError?
          {data:null,error:new Error("source offline")}:
          {data:table==="alerts"?{...source,status:options?.sourceStatus??"new"}:
            {kind:"data_quality",status:"needs_owner",owner_user_id:"owner-a",
              confidence:"high",evidence:[]},error:null};},
        async limit(){return {data:table==="alerts"?
          [{kind:"sales_anomaly",status:"new"}]:
          [{kind:"data_quality",status:"needs_owner",owner_user_id:"owner-a"}],error:null};},
      };return builder;
    },
  };
  return {client:client as never,calls};
}
const previousKey=process.env.OPENAI_API_KEY;
beforeEach(()=>{
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY="test-agentic-model-key";
  mocks.access.mockResolvedValue(undefined);
  mocks.identity.mockResolvedValue({asOf:"2026-11-14",timezone:"America/Los_Angeles",currency:"USD"});
  mocks.tools.mockReturnValue({getProfitability:vi.fn(),getSalesTrend:vi.fn(),getMenuCatalog:vi.fn()});
  mocks.budget.mockImplementation(async(_cap:unknown,work:()=>Promise<unknown>)=>work());
  mocks.notify.mockImplementation(async(_db:unknown,_request:unknown,write:()=>Promise<unknown>)=>
    ({decision:"posted",result:await write()}));
  mocks.model.mockResolvedValue(agentResult());
  mocks.priorities.mockResolvedValue([]);
});
afterEach(()=>{if(previousKey===undefined)delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY=previousKey;});
describe("Task 15A operational end-to-end orchestration (recorded source/model)",()=>{
  it("enqueues even already-notified revisions and keeps owner/café identity scoped",async()=>{
    mocks.priorities.mockResolvedValue([
      {source:{sourceType:"alert",sourceId:"alert-a"},
        revisionHash:"a".repeat(64),stableKey:"b".repeat(64),priority:315},
      {source:{sourceType:"operating_task",sourceId:"task-a"},
        revisionHash:"c".repeat(64),stableKey:"d".repeat(64),priority:120},
    ]);
    const d=db([]);
    const scope={businessId:"cafe-a",ownerUserId:"owner-a",threadId:"thread-a",localDate:"2026-11-14"};
    expect(await enqueueInvestigationsForOwner(d.client,scope,now)).toBe(2);
    expect(mocks.priorities).toHaveBeenCalledWith(d.client,scope,now,
      {includeNotified:true,limit:25});
    expect(d.calls.map(x=>x.name)).toEqual([
      "supervisor_enqueue_investigation","supervisor_enqueue_investigation",
    ]);
    expect(d.calls.map(x=>x.args.p_priority)).toEqual([315,120]);
    expect(d.calls.every(x=>x.args.p_business_id==="cafe-a"&&
      x.args.p_owner_user_id==="owner-a"&&x.args.p_thread_id==="thread-a")).toBe(true);
  });
  it("checkpoints a source scan before the first model investigation",async()=>{
    const d=db([{...collected}]);
    const status=await processNextInvestigation(d.client,now);
    expect(status).toMatchObject({processed:1,collected:1,investigated:0,failed:0});
    expect(mocks.model).not.toHaveBeenCalled();
    const saved=d.calls.find(x=>x.name==="supervisor_finish_investigation")?.args;
    expect(saved?.p_outcome).toBe("collected");
    expect(saved?.p_narrative).toBeNull();
    expect(saved?.p_evidence).toMatchObject({source:synopsis});
  });
  it("resumes a stored investigation, reads two canonical domains and reports only a verified outcome",async()=>{
    const d=db([{...investigating}]);
    const status=await processNextInvestigation(d.client,now);
    expect(status).toMatchObject({processed:1,investigated:1,failed:0});
    expect(mocks.access).toHaveBeenCalledWith("cafe-a");
    expect(mocks.tools).toHaveBeenCalledWith(
      {businessId:"cafe-a",ownerUserId:"owner-a"},d.client);
    expect(mocks.model).toHaveBeenCalledOnce();
    const modelInput=mocks.model.mock.calls[0][0];
    expect(modelInput.ownerText).toContain("SYSTEM-INITIATED");
    expect(modelInput.ownerText).toContain("TWO relevant independent");
    expect(modelInput.toolNames).toContain("get_sales");
    expect(modelInput.toolNames).toContain("get_labor");
    expect(modelInput.toolNames).not.toContain("propose_staff_change");
    expect(modelInput.toolNames).not.toContain("propose_gmail_action");
    expect(mocks.notify).toHaveBeenCalledOnce();
    const saved=d.calls.find(x=>x.name==="supervisor_finish_investigation")?.args;
    expect(saved?.p_outcome).toBe("investigated");
    expect(saved?.p_narrative).toBe(agentResult().text);
    expect(saved?.p_evidence).toMatchObject({modelTools:["get_sales","get_labor"],
      missing:["unverifiedWages"]});
  });
  it("reenters unresolved work after a restart without inventing owner consent",async()=>{
    const d=db([{...investigating},{...following}]);
    const result=await processDueInvestigations(d.client,now,2);
    expect(result).toMatchObject({processed:2,investigated:1,followUps:1,failed:0});
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.model.mock.calls[1][0].ownerText).toContain("persistent follow-up");
    expect(mocks.model.mock.calls[1][0].ownerText).toContain("Previous owner-visible plan");
    expect(d.calls.filter(x=>x.name==="supervisor_finish_investigation")
      .map(x=>x.args.p_outcome)).toEqual(["investigated","followed_up"]);
    expect(d.calls.every(x=>!x.name.includes("commit_effect")&&
      !x.name.includes("approve"))).toBe(true);
  });
  it("silently checkpoints unchanged short-interval monitoring without owner-message spam",async()=>{
    const d=db([{...following,last_error:null,evidence:{
      ...following.evidence,lastOwnerUpdate:now.toISOString(),unchangedChecks:0,
    }}]);
    const status=await processNextInvestigation(d.client,now);
    expect(status).toMatchObject({processed:1,rechecked:1,followUps:0,failed:0});
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(d.calls.find(x=>x.name==="supervisor_finish_investigation")?.args)
      .toMatchObject({p_outcome:"rechecked",p_narrative:null,
        p_evidence:expect.objectContaining({unchangedChecks:1})});
  });
  it("does not silently publish a one-tool answer as a multi-step investigation",async()=>{
    mocks.model.mockResolvedValue(agentResult({tools:["get_sales"]}));
    const d=db([{...investigating}]);
    expect(await processNextInvestigation(d.client,now)).toMatchObject({failed:1,investigated:0});
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(d.calls.find(x=>x.name==="supervisor_fail_investigation")?.args.p_error)
      .toBe("evidence_incomplete");
    expect(d.calls.some(x=>x.name==="supervisor_finish_investigation")).toBe(false);
  });
  it("recovers from temporary reader failure through durable fenced backoff",async()=>{
    const d=db([{...collected}],{sourceError:true});
    expect(await processNextInvestigation(d.client,now)).toMatchObject({failed:1});
    expect(mocks.model).not.toHaveBeenCalled();
    expect(d.calls.find(x=>x.name==="supervisor_fail_investigation")?.args.p_error)
      .toBe("source_unavailable");
  });
  it("blocks owner-visible results if entitlement is revoked during a model step",async()=>{
    mocks.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked"));
    const d=db([{...investigating}]);
    expect(await processNextInvestigation(d.client,now)).toMatchObject({
      processed:1,investigated:0,failed:1,
    });
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(d.calls.find(x=>x.name==="supervisor_fail_investigation")?.args.p_error)
      .toBe("authorization_revoked");
  });
  it("does not bypass authorization, pretend model availability or create an owner message",async()=>{
    mocks.access.mockRejectedValue(new Error("denied"));
    const d=db([{...investigating}]);
    expect(await processNextInvestigation(d.client,now)).toMatchObject({failed:1});
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    const noProvider=db([{...investigating}]);
    delete process.env.OPENAI_API_KEY;
    expect(await processNextInvestigation(noProvider.client,now)).toMatchObject({failed:1});
    expect(noProvider.calls.find(x=>x.name==="supervisor_fail_investigation")?.args.p_error)
      .toBe("provider_unavailable");
  });
});
