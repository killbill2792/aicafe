import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:vi.fn()}));
vi.mock("@/lib/ai/cafeTools.server",()=>({
  createOwnerScopedCafeTools:vi.fn(()=>({})),
  readSupervisorCafeIdentity:vi.fn(async()=>({asOf:"2026-11-20",
    timezone:"America/Los_Angeles",currency:"USD"})),
}));
vi.mock("@/lib/ai/supervisor/runs/worker.server",()=>({
  assertDurablePaidTurnAllowed:vi.fn(),
}));
vi.mock("@/lib/ai/supervisor/runs/usage.server",()=>({
  loadModelExecutionCap:vi.fn(async()=>1200),
  withWorkerBudget:vi.fn(async(_budget,run)=>run()),
}));
vi.mock("@/lib/data/cafeEvents.server",()=>({
  readSavedEventTimeline:vi.fn(),
}));
vi.mock("@/lib/data/staffSchedule.server",()=>({
  getWeekSchedule:vi.fn(async()=>({ok:true,data:{shifts:[{id:"scoped-shift"}]}})),
}));
vi.mock("@/lib/data/financialEvidence.server",()=>({
  readFinancialEvidence:vi.fn(async()=>({missing:[],cash:{balanceCents:12345}})),
}));
vi.mock("@/lib/ai/agent/loop.server",()=>({openAIProvider:vi.fn()}));
vi.mock("@/lib/ai/research/turn.server",()=>({runResearchTurn:vi.fn()}));
vi.mock("./investigationUsage.server",()=>({
  meteredInvestigationProvider:vi.fn((_db,_scope,provider)=>({
    provider,problem:()=>null,
  })),
}));
vi.mock("@/lib/connectors/registry.server",()=>({
  getConnectorAccount:vi.fn(async()=>null),
  allowsGmail:vi.fn((account:unknown,permission:string)=>
    !!account&&permission==="read"&&(account as {read?:boolean}).read===true),
}));
vi.mock("@/lib/connectors/gmail/provider.server",()=>({
  gmailSearch:vi.fn(async()=>({messages:[{id:"external-gmail-id"}]})),
  gmailListLabels:vi.fn(async()=>({labels:[]})),
  gmailRead:vi.fn(async()=>({message:{id:"external-gmail-id"}})),
  gmailReadThread:vi.fn(async()=>({messages:[{id:"external-gmail-id"}]})),
  gmailReadAttachment:vi.fn(async()=>({filename:"vendor.csv",rows:[{value:4}]})),
}));
vi.mock("@/lib/operating/notifyOwner.server",()=>({
  notifyOwner:vi.fn(async(_db,_options,write)=>({
    decision:"posted",result:await write(),
  })),
}));

import {runResearchTurn as runAgentTurn} from "@/lib/ai/research/turn.server";
import {verifyObjectiveTurn,executeClaimedObjective,objectiveReadTools,
  observedObjectiveEvidence,routineObjectiveCheckpoint,watchReadTools} from "./objective.server";
import {notifyOwner} from "@/lib/operating/notifyOwner.server";
import {getConnectorAccount} from "@/lib/connectors/registry.server";
import {gmailSearch} from "@/lib/connectors/gmail/provider.server";
import {getWeekSchedule as scopedWeekSchedule} from "@/lib/data/staffSchedule.server";
import {readFinancialEvidence} from "@/lib/data/financialEvidence.server";

const identifier="11111111-1111-4111-8111-111111111111";
const objective={
  id:identifier,businessId:identifier,ownerUserId:identifier,
  threadId:identifier,title:"Weekly cross-domain review",
  cadence:"weekly" as const,weekdays:[1],localTime:"08:00",
  timezone:"America/Los_Angeles",status:"active" as const,revision:3,
  createdAt:"2026-11-01T00:00:00Z",updatedAt:"2026-11-20T00:00:00Z",
  executionMode:"objective" as const,
  objectiveText:"Review next week's staffing, stock, demand and costs.",
  objectiveSourceMessageId:identifier,objectiveUpdates:[],
};
const watch={...objective,title:"Luna Watch",executionMode:"watch" as const,
  objectiveSourceMessageId:null,
  objectiveText:"Look for independently verified important café issues."};
const lease={runId:"22222222-2222-4222-8222-222222222222",
  leaseToken:"33333333-3333-4333-8333-333333333333",revision:3};
const source={source:"sql_research",tool:"run_sql",period:null,missing:[],agentId:"alex"};
const turn=(text:string,overrides:Record<string,unknown>={})=>({
  text,endReason:"complete",unverified:[],results:[],
  toolInvocations:[{name:"run_sql",result:source}],
  usage:{modelCalls:2,toolCalls:1,inputTokens:280,outputTokens:70},
  ...overrides,
}) as never;
describe("U4 objective evidence and model autonomy",()=>{
  it("quietly completes a Watch when real evidence does not justify owner interruption",()=>{
    const result=verifyObjectiveTurn(turn("NO_ACTION_REQUIRED: Observed a normal week."),watch);
    expect(result.attention).toBe("none");
    expect(result.report).toBe("Observed a normal week.");
  });
  it("distinguishes a meaningful novel issue from a no-action review",()=>{
    const result=verifyObjectiveTurn(turn("ATTENTION: Review a verified staffing and inventory conflict."),watch);
    expect(result.attention).toBe("attention");
  });
  it("offers SQL, public search, saved events and (owner goals only) mailbox reads, and no effect or routine tool",()=>{
    for(const name of ["run_sql","describe_database","calculate","get_events"]){
      expect(objectiveReadTools).toContain(name);expect(watchReadTools).toContain(name);
    }
    expect(objectiveReadTools).toContain("search_web");
    expect(objectiveReadTools).toContain("search_gmail");
    for(const name of ["search_web","search_gmail","read_gmail"])expect(watchReadTools).not.toContain(name);
    for(const name of ["manage_routine","propose_price_change","query_data","describe_data","get_sales"]){
      expect(objectiveReadTools).not.toContain(name);expect(watchReadTools).not.toContain(name);
    }
  });
  it("accepts a successful SQL read as an observation, never a failed read, a catalog or a bare tool name",()=>{
    expect(observedObjectiveEvidence(source as never)).toBe(true);
    expect(observedObjectiveEvidence({...source,error:"research_tool_error"} as never)).toBe(false);
    expect(observedObjectiveEvidence({...source,tool:"describe_database"} as never)).toBe(false);
    expect(observedObjectiveEvidence({source:"sales",period:null,missing:[]})).toBe(false);
    expect(()=>verifyObjectiveTurn(turn("ATTENTION: Trust me.",{
      toolInvocations:[{name:"describe_database",result:{...source,tool:"describe_database"}}],
    }),watch)).toThrow("u4_no_verified_source_observation");
  });
  it("records bounded source metadata and a digest, one lineage for SQL, without raw rows",()=>{
    const result=verifyObjectiveTurn(turn("ATTENTION: Review a verified staffing and stock conflict.",{
      toolInvocations:[{name:"run_sql",result:source},{name:"run_sql",result:{...source,missing:["partial"]}}],
    }),watch);
    expect(result.sourceDomains).toEqual(["other:sql_research"]);
    expect(result.sourceRefs).toHaveLength(1);
    expect(result.sourceRefs[0].evidenceDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(result.sourceRefs)).not.toContain("rows");
  });
  it("rejects unsupported numeric facts, model failure, unsupported external effects",()=>{
    expect(()=>verifyObjectiveTurn(turn("ATTENTION: Sales were 10424.",{
      unverified:[{key:"invented",value:10424}],
    }),watch)).toThrow("u4_model_result_unverified");
    expect(()=>verifyObjectiveTurn(turn("ATTENTION: data unavailable",{
      endReason:"provider_failed",
    }),watch)).toThrow("u4_model_result_unverified");
  });
});
describe("U4 owner-only connector capability and independent mailbox revocation",()=>{
  it("rejects a forged external Gmail tool receipt in an unsolicited Watch",()=>{
    expect(()=>verifyObjectiveTurn(turn("NO_ACTION_REQUIRED: Mail looked quiet.",{
      toolInvocations:[{name:"search_gmail",result:{
        source:"gmail",period:null,missing:[],messages:[{id:"vendor-msg-987654"}],
      }}],
    }),watch)).toThrow("u4_unadmitted_tool_invocation");
  });
  it("refuses an unexpected external effect even alongside genuine café facts",()=>{
    const effectAttempt=turn("Review real café evidence.",{
      toolInvocations:[
        {name:"run_sql",result:source},
        {name:"propose_price_change",result:{
          source:"price_proposal",period:null,missing:[],proposalCreated:true,
        }},
      ],
    });
    expect(()=>verifyObjectiveTurn(effectAttempt,objective))
      .toThrow("u4_unadmitted_tool_invocation");
    expect(()=>verifyObjectiveTurn(turn("NO_ACTION_REQUIRED: Sales are normal.",{
      toolInvocations:[
        {name:"run_sql",result:source},
        {name:"read_gmail",result:{
          source:"gmail",period:null,missing:[],message:{id:"vendor-msg-987654"},
        }},
      ],
    }),watch)).toThrow("u4_unadmitted_tool_invocation");
  });
  it("counts a real provider message identity as external source evidence, not canonical money",()=>{
    expect(observedObjectiveEvidence({
      source:"gmail",period:null,missing:[],message:{id:"vendor-msg-987654"},
    } as never)).toBe(true);
    expect(observedObjectiveEvidence({
      source:"gmail",period:null,missing:[],message:{id:"x"},
    } as never)).toBe(false);
  });
  it("reads only a separately consented owner mailbox and marks its proof partial",async()=>{
    vi.mocked(getConnectorAccount).mockResolvedValue({
      id:"account-a",generation:1,provider_subject:"subject-a",read:true,
    } as never);
    try{
      vi.mocked(runAgentTurn).mockImplementationOnce(async args=>{
        const gmail=args.actions!.context.gmail;
        expect(gmail).toBeDefined();
        const mail=await gmail!.search("supplier replies",3);
        expect(mail).toMatchObject({messages:[{id:"external-gmail-id"}]});
        return turn("Review these supplier claims, verify before payment.",{
          toolInvocations:[{name:"search_gmail",result:{
            source:"gmail",period:null,missing:[],messages:[{id:"external-gmail-id"}],
          }}],
        });
      });
      const rpc=vi.fn(async()=>({data:true,error:null}));
      const outcome=await executeClaimedObjective({rpc,...mockRoutineHistory()} as never,{
        routine:objective,lease,localDate:"2026-11-20",
        provider:(async function*(){}) as never,
      });
      expect(outcome.observedToolNames).toEqual(["search_gmail"]);
      expect(gmailSearch).toHaveBeenCalledWith(
        {businessId:objective.businessId,ownerUserId:objective.ownerUserId},
        "supplier replies",3);
      expect(rpc).toHaveBeenCalledWith("u4_publish_objective_report",
        expect.objectContaining({p_proof:expect.objectContaining({
          quality:"partial",sources:[expect.objectContaining({
            source:"unverified_external",identifier:"search_gmail",
          })],
        })}));
    }finally{vi.mocked(getConnectorAccount).mockReset();}
  });
  it("fails closed if Gmail read access changes between source read and report",async()=>{
    vi.mocked(getConnectorAccount)
      .mockResolvedValueOnce({id:"account-a",generation:1,
        provider_subject:"subject-a",read:true} as never)
      .mockResolvedValueOnce({id:"account-a",generation:2,
        provider_subject:"subject-a",read:false} as never);
    vi.mocked(runAgentTurn).mockImplementationOnce(async args=>{
      await args.actions!.context.gmail!.read("vendor-msg-987654");
      return turn("This response must never be accepted.");
    });
    const rpc=vi.fn(async()=>({data:true,error:null}));
    try{
      await expect(executeClaimedObjective({rpc,...mockRoutineHistory()} as never,{
        routine:objective,lease,localDate:"2026-11-20",
        provider:(async function*(){}) as never,
      })).rejects.toThrow("u4_mailbox_permission_changed");
      expect(rpc).not.toHaveBeenCalledWith("u4_publish_objective_report",expect.anything());
    }finally{vi.mocked(getConnectorAccount).mockReset();}
  });
});
describe("U4 original work-identity checkpoints",()=>{
  it("journals only tool digests and replays NO private result or unverified effect",async()=>{
    const steps=[
      {stage:"provider_start",tool:null},
      {stage:"tool_start",tool:"get_sales"},
      {stage:"tool_complete",tool:null},
    ];
    const rpc=vi.fn(async(name:string,_args?:unknown)=>{
      if(name==="u4_checkpoint_model_step")return {data:true,error:null};
      return {data:false,error:null};
    });
    const from=vi.fn(()=>({
      select:()=>({eq:()=>({eq:()=>({eq:()=>({
        maybeSingle:async()=>({data:{u4_checkpoint:{steps}},error:null}),
      })})})}),
    }));
    const checkpoint=routineObjectiveCheckpoint({rpc,from} as never,{
      routine:objective,lease,assertLease:async()=>{},
    });
    await checkpoint.beginProvider();
    expect(await checkpoint.beginTool("get_sales",{
      source:"private source",amountCents:99999,
    },true)).toBeNull();
    await checkpoint.endTool(source as never);
    await checkpoint.endProvider(true);
    const calls=rpc.mock.calls.filter(c=>c[0]==="u4_checkpoint_model_step");
    expect(calls).toHaveLength(4);
    expect(calls.every(c=>!JSON.stringify(c[1]).includes("99999"))).toBe(true);
    const continuation=await checkpoint.resumeContext();
    expect(continuation).toContain("RESUMED ORIGINAL ROUTINE OCCURRENCE");
    expect(continuation).toContain("get_sales");
    expect(continuation).not.toContain("99999");
    expect(await checkpoint.restoredResults?.()).toEqual([]);
  });
  it("fails closed when checkpoint DB rejects its exact lease",async()=>{
    const rpc=vi.fn(async()=>({data:false,error:null}));
    const checkpoint=routineObjectiveCheckpoint({rpc} as never,{
      routine:objective,lease,assertLease:async()=>{},
    });
    await expect(checkpoint.beginProvider()).rejects.toThrow("u4_checkpoint_lease_lost");
  });
});
function mockRoutineHistory(rows:unknown[]=[]){
  return {from:vi.fn(()=>({
    select:()=>({eq:()=>({eq:()=>({eq:()=>({lt:()=>({
      order:()=>({limit:async()=>({data:rows,error:null})}),
    })})})})}),
  }))};
}
describe("U4 scheduled model execution persists only verified outcomes",()=>{
  it("runs model-led goal with original authenticated message context, one lease and report",async()=>{
    vi.mocked(runAgentTurn).mockResolvedValueOnce(turn("Check staffing and inventory next week."));
    const rpc=vi.fn(async(name:string)=>{
      if(name==="u4_routine_lease_active")return {data:true,error:null};
      if(name==="u4_publish_objective_report")return {data:true,error:null};
      throw Error("unexpected RPC "+name);
    });
    const outcome=await executeClaimedObjective({rpc,...mockRoutineHistory()} as never,{
      routine:objective,lease,localDate:"2026-11-20",
      provider:(async function*(){}) as never,
    });
    expect(outcome.attention).toBe("attention");
    expect(outcome.sourceCount).toBe(1);
    const args=vi.mocked(runAgentTurn).mock.calls.at(-1)?.[0];
    expect(args?.ownerText).toContain("Review next week's staffing, stock, demand and costs.");
    expect(args?.ownerText).toContain("SYSTEM-EXECUTED OWNER ROUTINE");
    expect(args?.ownerText).toContain("PRIOR_ASSESSMENTS=[]");
    expect(args?.scope).toMatchObject({businessId:objective.businessId,ownerUserId:objective.ownerUserId});
    const offered=args?.actions?.definitions.map((d:{name:string})=>d.name)??[];
    expect(offered).toContain("get_events");
    expect(offered).toContain("search_gmail");
    for(const old of ["manage_routine","query_data","describe_data","get_sales","get_inventory"])expect(offered).not.toContain(old);
    expect(rpc.mock.calls.filter(c=>c[0]==="u4_routine_lease_active").length).toBeGreaterThanOrEqual(2);
    expect(rpc).toHaveBeenCalledWith("u4_publish_objective_report",
      expect.objectContaining({p_run_id:lease.runId,p_attention:"attention"}));
    expect(notifyOwner).toHaveBeenCalled();
  });
  it("gives the model earlier conclusions as hypotheses, not new verified source facts",async()=>{
    vi.mocked(runAgentTurn).mockResolvedValueOnce(turn("Evidence changed; revise last conclusion."));
    const rpc=vi.fn(async()=>({data:true,error:null}));
    const last=[{local_date:"2026-11-19",u4_result:{
      attention:"attention",summary:"Potential supply interruption; verify again."}}];
    await executeClaimedObjective({rpc,...mockRoutineHistory(last)} as never,{
      routine:objective,lease,localDate:"2026-11-20",
      provider:(async function*(){}) as never,
    });
    const prompt=vi.mocked(runAgentTurn).mock.calls.at(-1)?.[0]?.ownerText;
    expect(prompt).toContain("Potential supply interruption");
    expect(prompt).toContain("NOT current verified source evidence");
  });
  it("silent Watch never invokes owner notice, but commits its source receipt",async()=>{
    vi.mocked(runAgentTurn).mockResolvedValueOnce(turn("NO_ACTION_REQUIRED: No significant changes."));
    vi.mocked(notifyOwner).mockClear();
    const rpc=vi.fn(async()=>({data:true,error:null}));
    const result=await executeClaimedObjective({rpc,...mockRoutineHistory()} as never,{
      routine:watch,lease,localDate:"2026-11-20",
      provider:(async function*(){}) as never,
    });
    expect(result.attention).toBe("none");
    const watchTurn=vi.mocked(runAgentTurn).mock.calls.at(-1)?.[0];
    const offered=watchTurn?.actions?.definitions.map((d:{name:string})=>d.name)??[];
    expect(offered).toEqual(expect.arrayContaining(["get_events","get_schedule","get_week_schedule","get_staff_messages"]));
    expect(offered).not.toContain("search_gmail");
    expect(watchTurn?.webSearch).toBeUndefined();
    expect(watchTurn?.ownerText).toContain("never read employee-level wages, payroll or staff messages");
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("u4_publish_objective_report",
      expect.objectContaining({p_attention:"none"}));
  });
  it("revoked lease fences model before a paid call or report",async()=>{
    const rpc=vi.fn(async()=>({data:false,error:null}));
    await expect(executeClaimedObjective({rpc,...mockRoutineHistory()} as never,{
      routine:objective,lease,localDate:"2026-11-20",
      provider:(async function*(){}) as never,
    })).rejects.toThrow("u4_objective_lease_revoked");
    expect(rpc).not.toHaveBeenCalledWith("u4_publish_objective_report",expect.anything());
  });
});
