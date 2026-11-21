import {beforeEach,afterEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
  model:vi.fn(),access:vi.fn(),tools:vi.fn(),identity:vi.fn(),
  budget:vi.fn(),notify:vi.fn(),priorities:vi.fn(),paidGate:vi.fn(),stockDraft:vi.fn(),linkedProposals:vi.fn(),attempt:vi.fn(),
}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:mocks.access}));
vi.mock("@/lib/ai/cafeTools.server",()=>({
  createOwnerScopedCafeTools:mocks.tools,readSupervisorCafeIdentity:mocks.identity,
}));
vi.mock("@/lib/ai/agent/loop.server",()=>({runAgentTurn:mocks.model,
  openAIProvider:vi.fn()}));
vi.mock("@/lib/ai/supervisor/runs/worker.server",()=>({
  assertDurablePaidTurnAllowed:mocks.paidGate,
}));
vi.mock("@/lib/ai/supervisor/runs/usage.server",()=>({withWorkerBudget:mocks.budget,loadModelExecutionCap:async()=>1200}));
vi.mock("@/lib/operating/notifyOwner.server",()=>({notifyOwner:mocks.notify}));
vi.mock("./dispatch.server",()=>({readActionablePriorities:mocks.priorities}));
vi.mock("./stockDraft.server",()=>({prepareProactiveStockDraft:mocks.stockDraft}));
vi.mock("@/lib/ai/supervisor/loop/reads.server",()=>({readOwnerProposals:mocks.linkedProposals}));
vi.mock("@/lib/ai/supervisor/loop/effectGateway.server",()=>({SupervisorEffectGateway:class{readAttempt=mocks.attempt;}}));
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
  stable_key:"b".repeat(64),episode_id:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  step_version:0,lease_token:"lease-a",
};
const collected={...base,phase:"collect",evidence:{}};
const investigating={...base,phase:"investigate",step_version:1,
  evidence:{source:synopsis,collectedAt:now.toISOString()}};
const following={...base,phase:"awaiting_owner",step_version:2,
  narrative:"Previous owner-visible plan: examine wage coverage and propose an approved roster adjustment.",
  evidence:{source:synopsis,collectedAt:now.toISOString()}};
const agentResult=(patch:Record<string,unknown>={})=>({
  text:"I checked sales and labor coverage. Staffing remains uncertain. Review the owner approval card before any change; I will check again.",
  endReason:"complete",tools:["get_investigation_source","get_sales","get_labor"],unverified:[],
  results:[{source:"investigation_source",period:null,missing:[],
      sourceType:"alert",sourceId:"alert-a",incidentKind:"sales_anomaly"},
    {source:"sales",period:null,missing:[],netSalesCents:12000,
      days:[{date:"2026-11-14",netSalesCents:12000}]},
    {source:"labor",period:null,missing:["unverifiedWages"],
      laborDays:[{date:"2026-11-14",wagesCents:2000,wageStatus:"missing"}]}],
  toolInvocations:[
    {name:"get_investigation_source",result:{source:"investigation_source",
      period:null,missing:[],sourceType:"alert",sourceId:"alert-a",
      incidentKind:"sales_anomaly"}},
    {name:"get_sales",result:{source:"sales",period:null,missing:[],
      netSalesCents:12000,days:[{date:"2026-11-14",netSalesCents:12000}]}},
    {name:"get_labor",result:{source:"labor",period:null,missing:["unverifiedWages"],
      laborDays:[{date:"2026-11-14",wagesCents:2000,wageStatus:"missing"}]}},
  ],
  usage:{modelCalls:2,toolCalls:2,inputTokens:100,outputTokens:100,cachedTokens:0,latencyMs:200},
  ...patch,
});
function db(claims:Record<string,unknown>[],options?:{
  sourceError?:boolean;sourceStatus?:string;sourceKind?:string;
  alertPayload?:Record<string,unknown>;timecard?:Record<string,unknown>|null;
  taskStatus?:string;relatedTasks?:Record<string,unknown>[];
}){
  const calls:Array<{name:string;args:Record<string,unknown>}>=[];
  const reads:Array<{table:string;column:string;value:unknown}>=[];
  const client={
    rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
      calls.push({name,args});
      return {data:name==="supervisor_claim_investigation"?claims.shift()??null:true,error:null};
    }),
    from:(table:string)=>{
      let excluded=new Set<string>();
      const builder={
        select(){return builder},eq(column:string,value:unknown){reads.push({table,column,value});return builder},in(){return builder},
        not(field:string,operator:string,value:string){
          if(table==="operating_tasks"&&field==="kind"&&operator==="in")
            excluded=new Set(value.slice(1,-1).split(","));
          return builder;
        },
        or(){return builder},order(){return builder},
        async maybeSingle(){return options?.sourceError?
          {data:null,error:new Error("source offline")}:
          {data:table==="alerts"?{
            ...source,kind:options?.sourceKind??source.kind,
            payload:options?.alertPayload??source.payload,
            status:options?.sourceStatus??"new",
          }:table==="timecards"?options?.timecard??null:{
            kind:"data_quality",status:options?.taskStatus??"needs_owner",
            owner_user_id:"owner-a",confidence:"high",evidence:[],
            payload:{awaitingPriceApplication:true,priceAppliedToPos:false},
            entity_type:"menu_item",entity_id:"item-a",
          },error:null};},
        async limit(){
          const rows=table==="alerts"?
            [{kind:"sales_anomaly",status:"new"}]:
            options?.relatedTasks??[{kind:"data_quality",status:"needs_owner",owner_user_id:"owner-a"}];
          // Reflect PostgREST .not(kind,in,...) before .order().limit(8).
          return {data:rows.filter(row=>!excluded.has(String(row.kind))).slice(0,8),error:null};
        },
      };return builder;
    },
  };
  return {client:client as never,calls,reads};
}
const previousKey=process.env.OPENAI_API_KEY;
beforeEach(()=>{
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY="test-agentic-model-key";
  mocks.access.mockResolvedValue(undefined);
  mocks.paidGate.mockResolvedValue(undefined);
  mocks.identity.mockResolvedValue({asOf:"2026-11-14",timezone:"America/Los_Angeles",currency:"USD"});
  mocks.tools.mockReturnValue({getProfitability:vi.fn(),getSalesTrend:vi.fn(),getMenuCatalog:vi.fn()});
  mocks.budget.mockImplementation(async(_cap:unknown,work:()=>Promise<unknown>)=>work());
  mocks.notify.mockImplementation(async(_db:unknown,_request:unknown,write:()=>Promise<unknown>)=>
    ({decision:"posted",result:await write()}));
  mocks.model.mockResolvedValue(agentResult());
  mocks.priorities.mockResolvedValue([]);
  mocks.stockDraft.mockReset().mockResolvedValue({state:"missing"});
  mocks.linkedProposals.mockReset().mockResolvedValue([]);
  mocks.attempt.mockReset().mockResolvedValue(null);
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
  it("never enqueues a supplier PO draft as an investigation even if a reader regresses",async()=>{
    mocks.priorities.mockResolvedValue([
      {source:{sourceType:"supplier_po",sourceId:"po-old"},
        revisionHash:"a".repeat(64),stableKey:"b".repeat(64),priority:135},
      {source:{sourceType:"alert",sourceId:"urgent-sales"},
        revisionHash:"c".repeat(64),stableKey:"d".repeat(64),priority:315},
    ]);
    const d=db([]);
    const scope={businessId:"cafe-a",ownerUserId:"owner-a",threadId:"thread-a",localDate:"2026-11-14"};
    expect(await enqueueInvestigationsForOwner(d.client,scope,now)).toBe(1);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]).toMatchObject({
      name:"supervisor_enqueue_investigation",
      args:{p_source_type:"alert",p_source_id:"urgent-sales",
        p_business_id:"cafe-a",p_owner_user_id:"owner-a"},
    });
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
  it("never starts the model after owner daily quota is exhausted",async()=>{
    mocks.paidGate.mockRejectedValue({code:"owner_usage_limit_reached"});
    const d=db([{...investigating}]);
    const status=await processNextInvestigation(d.client,now);
    expect(status).toMatchObject({processed:1,failed:1,investigated:0});
    expect(mocks.model).not.toHaveBeenCalled();
    expect(d.calls.find(x=>x.name==="supervisor_fail_investigation")?.args)
      .toMatchObject({p_error:"owner_quota_reached"});
  });
  it("fails closed when the joint owner usage ledger cannot be read",async()=>{
    mocks.paidGate.mockRejectedValue({code:"usage_unavailable"});
    const d=db([{...investigating}]);
    const status=await processNextInvestigation(d.client,now);
    expect(status).toMatchObject({processed:1,failed:1,investigated:0});
    expect(mocks.model).not.toHaveBeenCalled();
    expect(d.calls.find(x=>x.name==="supervisor_fail_investigation")?.args)
      .toMatchObject({p_error:"storage_failed"});
  });
  it("resumes a stored investigation, reads two canonical domains and reports only a verified outcome",async()=>{
    const d=db([{...investigating}]);
    const status=await processNextInvestigation(d.client,now);
    expect(status).toMatchObject({processed:1,investigated:1,failed:0});
    expect(mocks.access).toHaveBeenCalledWith("cafe-a");
    // Real provider run #43672525338 reached a real incident plus three
    // separate evidence domains, yet hit the old worker meter before a final
    // verified owner report. Reserve six model calls (including the final
    // no-tool response); retain read-only tools and the 55-second timeout.
    expect(mocks.budget).toHaveBeenCalledWith({
      maxElapsedMs:55_000,maxModelCalls:6,maxToolCalls:7,
      maxInputTokens:72_000,maxOutputTokens:4800,
    },expect.any(Function),1200);

    expect(mocks.tools).toHaveBeenCalledWith(
      {businessId:"cafe-a",ownerUserId:"owner-a"},d.client);
    expect(mocks.model).toHaveBeenCalledOnce();
    const modelInput=mocks.model.mock.calls[0][0];
    expect(modelInput.ownerText).toContain("SYSTEM-INITIATED");
    expect(modelInput.ownerText).toContain("as many or as few useful available tools");
    expect(modelInput.ownerText).not.toContain("at least TWO");
    expect(modelInput.toolNames).toContain("get_investigation_source");
    expect(modelInput.toolNames).toContain("get_sales");
    expect(modelInput.toolNames).toContain("get_labor");
    expect(modelInput.toolNames).not.toContain("propose_staff_change");
    expect(modelInput.toolNames).not.toContain("propose_gmail_action");
    // The model may only inspect the SQL-claimed café/owner/source.
    const exact=await modelInput.context.investigation.read();
    expect(exact).toMatchObject({
      source:"investigation_source",sourceType:"alert",sourceId:"alert-a",
      incidentKind:"sales_anomaly",sourceStatus:"new",
    });
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify.mock.calls[0][1].taskId).toContain("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const saved=d.calls.find(x=>x.name==="supervisor_finish_investigation")?.args;
    expect(saved?.p_outcome).toBe("investigated");
    expect(saved?.p_narrative).toBe(agentResult().text);
    expect(saved?.p_evidence).toMatchObject({modelTools:["get_investigation_source","get_sales","get_labor"],
      missing:["unverifiedWages"]});
  });
  it("reenters unresolved work after a restart without inventing owner consent",async()=>{
    const d=db([{...investigating},{...following}]);
    const result=await processDueInvestigations(d.client,now,2);
    expect(result).toMatchObject({processed:2,investigated:1,followUps:1,failed:0});
    expect(mocks.model).toHaveBeenCalledTimes(2);
    // Same cron invocation can immediately continue work after a persisted
    // collect step; repeated frozen timestamps would delay it 15 minutes.
    const claims=d.calls.filter(x=>x.name==="supervisor_claim_investigation");
    expect(Date.parse(String(claims[1].args.p_now)))
      .toBeGreaterThan(Date.parse(String(claims[0].args.p_now)));
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
  it("rechecks a customer's durable investigation when an owner-linked gateway attempt changes, without performing an effect",async()=>{
    const previous={proposalId:"proposal-a",capabilityId:"alex.price",status:"draft",revision:1,attemptState:null};
    const sourceSynopsis={...synopsis,kind:"business_anomaly"};
    const claim={...following,last_error:null,evidence:{...following.evidence,source:sourceSynopsis,
      sourceRevision:base.revision_hash,lastOwnerUpdate:now.toISOString(),customerLinkedActions:[previous]}};
    const options={sourceKind:"business_anomaly",alertPayload:{family:"customer_trend",subject:"returning_visit_share",quality:"verified",severity:"high"}};
    mocks.linkedProposals.mockResolvedValue([{id:"proposal-a",capability_id:"alex.price",status:"draft",revision:1}]);
    const stable=db([claim],options);
    expect(await processNextInvestigation(stable.client,now)).toMatchObject({rechecked:1,failed:0});
    expect(mocks.model).not.toHaveBeenCalled();
    mocks.linkedProposals.mockResolvedValue([{id:"proposal-a",capability_id:"alex.price",status:"committed",revision:2}]);
    mocks.attempt.mockResolvedValue({state:"verified"});
    const changed=db([claim],options);
    // A deliberately incomplete model response must not fabricate causal proof.
    mocks.model.mockResolvedValue(agentResult({text:"I cannot independently establish the current customer trend."}));
    await processNextInvestigation(changed.client,now);
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.linkedProposals).toHaveBeenLastCalledWith(changed.client,
      expect.objectContaining({businessId:"cafe-a",ownerUserId:"owner-a",threadId:"thread-a"}),
      {threadId:"thread-a",customerInvestigationContext:{episodeId:base.episode_id,sourceId:base.source_id},limit:21});
    expect(mocks.attempt).toHaveBeenLastCalledWith(expect.objectContaining({businessId:"cafe-a",ownerUserId:"owner-a",threadId:"thread-a"}),"proposal-a");
    const actual=await mocks.model.mock.calls[0][0].context.investigation.read();
    expect(actual.customerLinkedActions).toEqual([{capabilityId:"alex.price",status:"committed",attemptState:"verified"}]);
    expect(mocks.model.mock.calls[0][0].toolNames).not.toContain("propose_price_change");
    expect(changed.calls.every(x=>!x.name.includes("commit_effect")&&!x.name.includes("approve"))).toBe(true);
  });
  it("never treats its own saved priority notices as new café evidence six hours later",async()=>{
    const original={...following,last_error:null,evidence:{
      ...following.evidence,lastOwnerUpdate:now.toISOString(),unchangedChecks:0,
    }};
    // Newest nine rows are generated receipts, followed by the original
    // actionable task. The query must exclude receipts BEFORE limiting to 8.
    const receipts=Array.from({length:9},(_,i)=>({
      kind:i%2===0?"priority_notice":"event_report",status:"needs_owner",
      owner_user_id:"owner-a",
    }));
    const d=db([original],{relatedTasks:[
      ...receipts,{kind:"data_quality",status:"needs_owner",owner_user_id:"owner-a"},
    ]});
    const status=await processNextInvestigation(d.client,
      new Date(now.getTime()+6*60*60*1000));
    expect(status).toMatchObject({processed:1,rechecked:1,followUps:0,failed:0});
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    const saved=d.calls.find(x=>x.name==="supervisor_finish_investigation")?.args;
    expect(saved).toMatchObject({p_outcome:"rechecked",p_narrative:null,
      p_evidence:expect.objectContaining({unchangedChecks:1})});
    expect(saved?.p_evidence).toMatchObject({
      source:expect.objectContaining({relatedTasks:["data_quality"]}),
    });
  });
  it("reads and corroborates the exact employee timecard in the claimed café",async()=>{
    const timecardId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const employeeId="bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const payload={timecardId,employeeId,date:"2026-11-14",
      employeeName:"Employee A",reasonCode:"NO_QUALIFYING_30_MIN_BREAK_BY_HOUR_5"};
    const timecard={id:timecardId,employee_id:employeeId,
      clock_in:"2026-11-14T08:00:00Z",clock_out:"2026-11-14T16:00:00Z",
      breaks:[{start:"2026-11-14T12:00:00Z",end:"2026-11-14T12:10:00Z"}]};
    const meal={kind:"meal_break",status:"new",quality:"verified",severity:"high",
      relatedAlerts:["meal_break"],relatedTasks:["data_quality"]};
    const claim={...investigating,source_id:"meal-break-claim",
      evidence:{source:meal,collectedAt:now.toISOString()}};
    const d=db([claim],{sourceKind:"meal_break",alertPayload:payload,timecard});
    mocks.model.mockImplementation(async(args:Record<string,unknown>)=>{
      const context=(args.context as Record<string,unknown>).investigation as
        {read:()=>Promise<Record<string,unknown>>};
      const exact=await context.read();
      expect(exact).toMatchObject({source:"investigation_source",
        sourceId:"meal-break-claim",incidentKind:"meal_break",
        selectors:{timecardId,employeeId,date:"2026-11-14"},
        linkedTimecard:{id:timecardId,employeeId,clockIn:timecard.clock_in},
        missing:[]});
      expect(JSON.stringify(exact)).not.toContain("NO_QUALIFYING"); // untrusted code is not a command
      expect(d.reads).toEqual(expect.arrayContaining([
        {table:"alerts",column:"business_id",value:"cafe-a"},
        {table:"timecards",column:"business_id",value:"cafe-a"},
        {table:"timecards",column:"id",value:timecardId},
      ]));
      return agentResult({toolInvocations:[
        {name:"get_investigation_source",result:exact},
        {name:"get_labor",result:{source:"labor_and_attendance",period:null,
          missing:["wagesIncomplete"],laborDays:[{date:"2026-11-14",wagesCents:null,
            wageStatus:"missing"}]}},
        // Dated shift schedule is independent of attendance/labor. Payroll
        // is a second labor projection and cannot corroborate itself.
        {name:"get_week_schedule",result:{source:"scheduled_shifts",period:null,
          missing:[],scheduleSet:true,shifts:[{date:"2026-11-14",id:"shift-a"}]}},
      ]});
    });
    expect(await processNextInvestigation(d.client,now))
      .toMatchObject({investigated:1,failed:0});
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
  it("fails closed on an alert pointing to a different employee's timecard",async()=>{
    const timecardId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const employeeId="bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const meal={kind:"meal_break",status:"new",quality:"verified",severity:"high",
      relatedAlerts:["meal_break"],relatedTasks:[]};
    const d=db([{...investigating,source_id:"meal-break-claim",
      evidence:{source:meal,collectedAt:now.toISOString()}}],
      {sourceKind:"meal_break",alertPayload:{timecardId,employeeId},
        timecard:{id:timecardId,employee_id:"other-employee",clock_in:"",clock_out:"",breaks:[]}});
    mocks.model.mockImplementation(async(args:Record<string,unknown>)=>{
      const exact=await ((args.context as Record<string,unknown>).investigation as
        {read:()=>Promise<Record<string,unknown>>}).read();
      expect(exact).toMatchObject({missing:["timecard_not_verified"],linkedTimecard:null});
      return agentResult({toolInvocations:[
        {name:"get_investigation_source",result:exact},
        {name:"get_labor",result:{source:"labor_and_attendance",period:null,missing:[]}},
        {name:"get_payroll_facts",result:{source:"payroll_facts",period:null,missing:[]}},
      ]});
    });
    expect(await processNextInvestigation(d.client,now))
      .toMatchObject({investigated:0,failed:1});
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("retries rather than reporting when two claimed domains only returned read failures",async()=>{
    mocks.model.mockResolvedValue(agentResult({toolInvocations:[
      {name:"get_investigation_source",result:{source:"investigation_source",
        period:null,missing:[],sourceType:"alert",sourceId:"alert-a",
        incidentKind:"sales_anomaly"}},
      {name:"get_labor",result:{source:"labor_and_attendance",
        period:null,missing:["laborReaderUnavailable"],laborDays:null}},
      {name:"get_week_schedule",result:{source:"scheduled_shifts",
        period:null,missing:["scheduleReadFailed"],shifts:null}},
    ]}));
    const d=db([{...investigating}]);
    expect(await processNextInvestigation(d.client,now))
      .toMatchObject({processed:1,failed:1,investigated:0});
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(d.calls.find(x=>x.name==="supervisor_fail_investigation")?.args)
      .toMatchObject({p_error:"evidence_incomplete"});
    expect(d.calls.some(x=>x.name==="supervisor_finish_investigation")).toBe(false);
  });
  it("does not silently publish a one-tool answer as a multi-step investigation",async()=>{
    mocks.model.mockResolvedValue(agentResult({toolInvocations:[
      {name:"get_sales",result:{source:"sales",period:null,missing:[]}},
    ]}));
    const d=db([{...investigating}]);
    expect(await processNextInvestigation(d.client,now)).toMatchObject({failed:1,investigated:0});
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(d.calls.find(x=>x.name==="supervisor_fail_investigation")?.args.p_error)
      .toBe("evidence_incomplete");
    expect(d.calls.some(x=>x.name==="supervisor_finish_investigation")).toBe(false);
  });
  it("does not accept a plausible model answer about a different incident",async()=>{
    mocks.model.mockResolvedValue(agentResult({toolInvocations:[
      {name:"get_investigation_source",result:{source:"investigation_source",
        period:null,missing:[],sourceType:"alert",sourceId:"other-alert",
        incidentKind:"sales_anomaly"}},
      {name:"get_sales",result:{source:"sales",period:null,missing:[]}},
      {name:"get_labor",result:{source:"labor",period:null,missing:[]}},
    ]}));
    const d=db([{...investigating}]);
    expect(await processNextInvestigation(d.client,now)).toMatchObject({
      processed:1,investigated:0,failed:1,
    });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(d.calls.find(x=>x.name==="supervisor_fail_investigation")?.args.p_error)
      .toBe("evidence_incomplete");
  });
  it.each([
    {name:"new draft",draft:{state:"draft",proposalId:"draft-a"},status:"A supplier order draft is available",expected:{stockPurchaseProposalId:"draft-a"}},
    {name:"existing order",draft:{state:"existing",summary:"Partial receipt is verified; delivery is not complete.",emailProposalId:"email-a",question:"Can you verify the remaining receipt?"},status:"Partial receipt is verified",expected:{stockEmailProposalId:"email-a",ownerQuestion:"Can you verify the remaining receipt?"}},
    {name:"missing evidence",draft:{state:"missing"},status:"Please confirm the missing stock count",expected:{missing:["stock_purchase_evidence_missing"]}},
    {name:"unverified draft",draft:null,status:"I could not verify the purchase draft",expected:{missing:["stock_purchase_draft_unverified"]}},
  ])("preserves the whole verified stock report and stores separate procurement status: $name",async({draft,status,expected})=>{
    const text="Observed evidence. ".repeat(90)+"The closing qualification must remain intact; delivery is not independently verified.";
    expect(text.length).toBeGreaterThan(1300);
    expect(text.length).toBeLessThanOrEqual(1800);
    const selectors={family:"stockout_risk",subject:"ingredient-a"};
    const exact={source:"investigation_source",period:null,missing:[],sourceType:"alert",sourceId:"alert-a",incidentKind:"business_anomaly",selectors};
    const inventory={source:"inventory",period:null,missing:[],rows:[{id:"ingredient-a",quantity:2}]};
    const costs={source:"ingredient_costs",period:null,missing:[],rows:[{id:"ingredient-a",unitCostCents:10}]};
    mocks.model.mockResolvedValue(agentResult({text,results:[exact,inventory,costs],toolInvocations:[
      {name:"get_investigation_source",result:exact},{name:"get_inventory",result:inventory},{name:"get_ingredient_costs",result:costs},
    ]}));
    if(draft)mocks.stockDraft.mockResolvedValue(draft);
    else mocks.stockDraft.mockRejectedValue(Error("draft not verified"));
    const d=db([{...investigating}],{sourceKind:"business_anomaly",alertPayload:{...selectors,quality:"verified"}});
    expect(await processNextInvestigation(d.client,now)).toMatchObject({processed:1,investigated:1,failed:0});
    expect(mocks.stockDraft).toHaveBeenCalledOnce();
    const saved=d.calls.find(x=>x.name==="supervisor_finish_investigation")?.args;
    expect(saved?.p_narrative).toBe(text);
    expect(saved?.p_evidence).toMatchObject({...expected,stockProcurementStatus:expect.stringContaining(status)});
  });
  it("logs a real provider rejection as retryable provider unavailability, never a database outage",async()=>{
    mocks.model.mockRejectedValue(new Error("provider_error"));
    const d=db([{...investigating}]);
    expect(await processNextInvestigation(d.client,now))
      .toMatchObject({processed:1,investigated:0,failed:1});
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(d.calls.find(x=>x.name==="supervisor_fail_investigation")?.args.p_error)
      .toBe("provider_unavailable");
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
