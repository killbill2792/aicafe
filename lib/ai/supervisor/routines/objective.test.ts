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
vi.mock("@/lib/ai/agent/loop.server",()=>({
  openAIProvider:vi.fn(),
  runAgentTurn:vi.fn(),
}));
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

import {runAgentTurn} from "@/lib/ai/agent/loop.server";
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
const source={source:"cafe_sales",period:{from:"2026-11-13",to:"2026-11-20"},
  missing:[],sales:{amountCents:10424,currency:"USD",complete:true}};
const turn=(text:string,overrides:Record<string,unknown>={})=>({
  text,endReason:"complete",unverified:[],results:[],
  toolInvocations:[{name:"get_sales",result:source}],
  usage:{modelCalls:2,toolCalls:1,inputTokens:280,outputTokens:70},
  ...overrides,
}) as never;
describe("U4 objective evidence and model autonomy",()=>{
  it("has broad existing registered reads but cannot manage routines or execute an effect",()=>{
    expect(objectiveReadTools).toContain("get_sales");
    expect(objectiveReadTools).toContain("get_inventory");
    expect(objectiveReadTools).toContain("get_events");
    expect(objectiveReadTools).toContain("get_staff_messages");
    expect(watchReadTools).not.toContain("get_staff_messages");
    expect(watchReadTools).not.toContain("get_labor");
    expect(watchReadTools).toContain("query_data");
    expect(objectiveReadTools).toContain("describe_data");
    expect(objectiveReadTools).toContain("query_data");
    expect(watchReadTools).toContain("describe_data");
    expect(watchReadTools).toContain("query_data");
    expect(objectiveReadTools).not.toContain("manage_routine");
    expect(objectiveReadTools).not.toContain("propose_price_change");
    expect(objectiveReadTools).not.toContain("propose_supplier_purchase_order");
    expect(objectiveReadTools).toContain("search_gmail");
    expect(objectiveReadTools).toContain("read_gmail");
    expect(watchReadTools).not.toContain("search_gmail");
    expect(watchReadTools).not.toContain("read_gmail");
    expect(watchReadTools).not.toContain("read_gmail_attachment");
  });
  it("accepts any real source read instead of forcing two hardcoded tools",()=>{
    const result=verifyObjectiveTurn(turn("Sales context suggests reviewing staffing."),objective);
    expect(result).toMatchObject({attention:"attention",sourceCount:1,
      observedToolNames:["get_sales"]});
    expect(result.sourceRefs).toMatchObject([{
      tool:"get_sales",source:"cafe_sales",domain:"recorded_sales",
      period:{from:"2026-11-13",to:"2026-11-20"},
    }]);
    expect(result.sourceRefs[0].evidenceDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(result.sourceRefs)).not.toContain("10424");
  });
  it("does not inflate corroboration from repeated calls or differently named views of one source",()=>{
    const same=verifyObjectiveTurn(turn("ATTENTION: Recorded sales need review.",{
      toolInvocations:[
        {name:"get_sales",result:source},
        {name:"get_sales",result:source},
        {name:"get_item_sales",result:{...source,items:[{quantity:4}]}},
      ],
    }),watch);
    expect(same.sourceCount).toBe(1);
    expect(same.sourceDomains).toEqual(["recorded_sales"]);
    const independent=verifyObjectiveTurn(turn("Review independent sales and inventory.",{
      toolInvocations:[
        {name:"get_sales",result:source},
        {name:"get_inventory",result:{source:"stock_snapshot",period:null,
          missing:[],items:[{quantity:3}]}},
      ],
    }),objective);
    expect(independent.sourceCount).toBe(2);
    expect(independent.sourceDomains).toEqual(["recorded_sales","stock_and_inventory"]);
  });
  it("does not call computed profit an independent source beside its sales inputs",()=>{
    const computed={source:"profitability",period:{from:"2026-11-13",to:"2026-11-20"},
      missing:[],ownerProfitCents:5024};
    const checked=verifyObjectiveTurn(turn("Review source-backed margin carefully.",{
      toolInvocations:[
        {name:"get_sales",result:source},
        {name:"get_profit",result:computed},
      ],
    }),objective);
    expect(checked.sourceCount).toBe(1);
    expect(checked.sourceDomains).toEqual(["recorded_sales"]);
    expect(checked.sourceRefs).toHaveLength(2);
    expect(checked.sourceRefs[1].domain).toBe("other:derived_cafe_profit");
  });
  it("attributes each canonical query to its real source, not generically to sales",()=>{
    const fromQuery=(view:string)=>({source:"canonical_data",view,
      period:{from:"2026-11-13",to:"2026-11-20"},missing:[],
      rows:[{count_business_date:4}],rowCount:1,sourceMix:{app:1},
      aggregateOnly:true,truncated:false});
    const result=verifyObjectiveTurn(turn("Review recorded sales and scheduling evidence.",{
      toolInvocations:[
        {name:"get_sales",result:source},
        {name:"query_data",result:fromQuery("cv_sales_days")},
        {name:"get_schedule",result:{source:"schedule",period:null,
          missing:[],shifts:[{durationHours:6}]}},
        {name:"query_data",result:fromQuery("cv_shifts")},
        {name:"query_data",result:fromQuery("cv_cash")},
        {name:"query_data",result:fromQuery("cv_cash")},
      ],
    }),objective);
    expect(result.sourceDomains).toEqual([
      "recorded_sales","dated_schedule","cash_management_records",
    ]);
    expect(result.sourceCount).toBe(3);
    expect(result.sourceRefs).toHaveLength(3);
    const unclassified=verifyObjectiveTurn(turn("An unfamiliar research view was observed.",{
      toolInvocations:[{name:"query_data",result:fromQuery("cv_not_yet_classified")}],
    }),objective);
    expect(unclassified.sourceDomains).toEqual(["other:canonical_data"]);
  });
  it("keeps signed multi-relation SQL auditable without inventing a second independent source",()=>{
    const signedSql={
      source:"u3_canonical_research",period:null,missing:[],
      truncated:false,rows:[{sum_net_sales_cents:10424}],
      evidence:{scope:"verified_owner_cafe_lease",
        receipt_id:"11111111-1111-4111-8111-111111111111",
        catalog_version:"b".repeat(16),column_units:{sum_net_sales_cents:"cents"},
        relation_names:["orders","order_lines"],query_fingerprint:"a".repeat(64)},
    };
    const alongside=verifyObjectiveTurn(turn("Recorded sales need verification.",{
      toolInvocations:[{name:"get_sales",result:source},
        {name:"query_data",result:signedSql}],
    }),objective);
    expect(alongside.sourceCount).toBe(1);
    expect(alongside.sourceDomains).toEqual(["recorded_sales"]);
    expect(alongside.sourceRefs).toHaveLength(2);
    expect(alongside.sourceRefs[1].relations).toEqual(["orders","order_lines"]);
    const alone=verifyObjectiveTurn(turn("Signed SQL observed facts.",{
      toolInvocations:[{name:"query_data",result:signedSql}],
    }),objective);
    expect(alone.sourceCount).toBe(1);
    expect(alone.sourceDomains).toEqual(["other:u3_signed_sql"]);
  });
  it("hashes all original observed source bytes without persisting their raw text",()=>{
    const common="recorded-context:".repeat(1300);
    const a=verifyObjectiveTurn(turn("Source A recorded." ,{
      toolInvocations:[{name:"get_sales",result:{...source,
        sourceNote:common+"suffix-a"}}],
    }),objective);
    const b=verifyObjectiveTurn(turn("Source B recorded.",{
      toolInvocations:[{name:"get_sales",result:{...source,
        sourceNote:common+"suffix-b"}}],
    }),objective);
    expect(a.sourceRefs[0].evidenceDigest).not.toBe(b.sourceRefs[0].evidenceDigest);
    expect(JSON.stringify(a.sourceRefs)).not.toContain("recorded-context:");
  });
  it("quietly completes a Watch when real evidence does not justify owner interruption",()=>{
    const result=verifyObjectiveTurn(turn("NO_ACTION_REQUIRED: Observed a normal week."),watch);
    expect(result.attention).toBe("none");
    expect(result.report).toBe("Observed a normal week.");
  });
  it("distinguishes a meaningful novel issue from a no-action review",()=>{
    const result=verifyObjectiveTurn(turn("ATTENTION: Review a verified staffing and inventory conflict."),watch);
    expect(result.attention).toBe("attention");
  });
  it("does not mistake data dictionaries and Gmail labels for observed café evidence",()=>{
    const discovery=turn("ATTENTION: Invented answer.",{
      toolInvocations:[{name:"describe_data",result:{
        source:"canonical_dictionary",period:null,missing:[],
        views:[{name:"cv_sales_days",columns:[{name:"net_cents"}]}],
      }}],
    });
    expect(()=>verifyObjectiveTurn(discovery,watch))
      .toThrow("u4_no_verified_source_observation");
    const labels=turn("Mailboxes are healthy.",{
      toolInvocations:[{name:"list_gmail_labels",result:{
        source:"gmail",period:null,missing:[],labels:[{id:"INBOX"}],
      }}],
    });
    expect(()=>verifyObjectiveTurn(labels,objective))
      .toThrow("u4_no_verified_source_observation");
  });
  it("rejects metadata-only canonical rows and SQL planning costs as fake facts",()=>{
    const dictionaryIsNotData={
      source:"canonical_data",view:"cv_sales_days",
      period:{from:"2026-11-13",to:"2026-11-20"},
      missing:[],empty:false,truncated:false,aggregateOnly:true,
      rows:[{business_date:"2026-11-20",source_ref:"opaque"}],
      rowCount:1,sourceMix:{toast:1},
    };
    expect(observedObjectiveEvidence(dictionaryIsNotData)).toBe(false);
    expect(()=>verifyObjectiveTurn(turn("ATTENTION: fabricated source conclusion.",{
      toolInvocations:[{name:"query_data",result:dictionaryIsNotData}],
    }),watch)).toThrow("u4_no_verified_source_observation");
    const sqlPlanWithoutFacts={source:"u3_canonical_research",
      period:null,missing:[],truncated:false,rows:[],estimatedCost:400,
      evidence:{scope:"verified_owner_cafe_lease"},
    };
    expect(observedObjectiveEvidence(sqlPlanWithoutFacts)).toBe(false);
    const realAggregate={...dictionaryIsNotData,
      rows:[{count_business_date:0}]};
    expect(observedObjectiveEvidence(realAggregate)).toBe(true);
  });
  it("never promotes untyped SQL literals into autonomous source observations",()=>{
    const fakeSql={source:"u3_canonical_research",period:null,
      missing:[],truncated:false,rows:[{inventedCents:99999}],
      evidence:{scope:"verified_owner_cafe_lease",
        receipt_id:"11111111-1111-4111-8111-111111111111",
        catalog_version:"a".repeat(16),query_fingerprint:"b".repeat(64),
        relation_names:["orders"],column_units:{}},
    };
    expect(observedObjectiveEvidence(fakeSql)).toBe(false);
    const validSql={...fakeSql,rows:[{count_orders:"0"}],
      evidence:{...fakeSql.evidence,column_units:{count_orders:"count"}}};
    expect(observedObjectiveEvidence(validSql)).toBe(true);
    expect(()=>verifyObjectiveTurn(turn("ATTENTION: invented revenue needs action.",{
      toolInvocations:[{name:"query_data",result:fakeSql}],
    }),watch)).toThrow("u4_no_verified_source_observation");
  });
  it("uses genuinely observed partial stock without treating stale Toast inventory as evidence",()=>{
    const stock={
      source:"inventory",period:{from:"2026-11-20",to:"2026-11-20"},
      missing:["stockNotObservedInLatestSuccess","stockQuantityUnknown"],
      inventory:[
        {source:"app",source_ref:"stock:current",evidence_state:"dated_owner_count",
          quantity:0,quantity_state:"known"},
        {source:"toast",source_ref:"stock:stale",evidence_state:"not_observed",
          quantity:null,stock_status:null,quantity_state:"unknown"},
      ],
    };
    expect(observedObjectiveEvidence(stock)).toBe(true);
    const checked=verifyObjectiveTurn(turn("Recorded inventory contains a dated zero and an unknown Toast item.",{
      toolInvocations:[{name:"get_inventory",result:stock}],
      results:[stock],
    }),objective);
    expect(checked.sourceCount).toBe(1);
    expect(checked.missing).toContain("stockQuantityUnknown");
    expect(observedObjectiveEvidence({...stock,inventory:stock.inventory.slice(1)})).toBe(false);
    expect(observedObjectiveEvidence({...stock,
      missing:["inventoryReaderUnavailable"]})).toBe(false);
  });
  it("denies a tool name without a verified observed source and refuses missing evidence",()=>{
    expect(observedObjectiveEvidence({source:"sales",period:null,missing:[]})).toBe(false);
    expect(observedObjectiveEvidence({source:"sales",period:null,missing:[],
      available:true,empty:false,rowCount:8,sourceCount:8,
      sourceMix:{toast:8},quality:{level:"high"},readAt:"2026-11-20",
    })).toBe(false);
    expect(observedObjectiveEvidence({...source,missing:["source_unavailable"]})).toBe(false);
    expect(()=>verifyObjectiveTurn(turn("ATTENTION: Trust me.",{
      toolInvocations:[{name:"get_sales",result:{source:"sales",period:null,missing:[]}}],
    }),watch)).toThrow("u4_no_verified_source_observation");
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
        {name:"get_sales",result:source},
        {name:"propose_price_change",result:{
          source:"price_proposal",period:null,missing:[],proposalCreated:true,
        }},
      ],
    });
    expect(()=>verifyObjectiveTurn(effectAttempt,objective))
      .toThrow("u4_unadmitted_tool_invocation");
    expect(()=>verifyObjectiveTurn(turn("NO_ACTION_REQUIRED: Sales are normal.",{
      toolInvocations:[
        {name:"get_sales",result:source},
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
        const gmail=args.context.gmail;
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
      await args.context.gmail!.read("vendor-msg-987654");
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
    expect(args?.serviceOrigin).toBe(true);
    expect(args?.ownerText).toContain("Review next week's staffing, stock, demand and costs.");
    expect(args?.ownerText).toContain("SYSTEM-EXECUTED OWNER ROUTINE");
    expect(args?.ownerText).toContain("PRIOR_ASSESSMENTS=[]");
    expect(args?.toolNames).toContain("get_inventory");
    expect(args?.toolNames).toContain("describe_data");
    expect(args?.toolNames).toContain("query_data");
    expect(args?.context.staffMessages).toBeDefined();
    expect(args?.context.staffCoordinationRead).toBeDefined();
    const sourceContext=await args?.context.canonicalData?.();
    expect(sourceContext).toMatchObject({
      businessId:objective.businessId,ownerUserId:objective.ownerUserId,
      threadId:objective.threadId,mode:"routine",
      runId:lease.runId,leaseToken:lease.leaseToken,aggregateOnly:true,
    });
    expect(sourceContext?.mode).not.toBe("owner");
    expect(args?.toolNames).not.toContain("manage_routine");
    expect(rpc.mock.calls.filter(c=>c[0]==="u4_routine_lease_active").length).toBeGreaterThanOrEqual(2);
    expect(rpc).toHaveBeenCalledWith("u4_publish_objective_report",
      expect.objectContaining({p_run_id:lease.runId,p_attention:"attention"}));
    expect(notifyOwner).toHaveBeenCalled();
  });
  it("binds cron schedule and finance tools to the original owner, never browser cookies",async()=>{
    const rpc=vi.fn(async()=>({data:true,error:null}));
    const db={rpc,...mockRoutineHistory()} as never;
    vi.mocked(runAgentTurn).mockImplementationOnce(async args=>{
      expect(args.toolNames).toContain("get_week_schedule");
      expect(args.toolNames).toContain("get_cashflow_evidence");
      const week=await args.context.readWeekSchedule?.("2026-11-16");
      const finance=await args.context.financialEvidenceRead?.({horizonDays:14});
      expect(week).toMatchObject({ok:true});
      expect(finance).toMatchObject({missing:[]});
      return turn("Verified scheduled financial evidence; owner action remains read-only.");
    });
    await executeClaimedObjective(db,{
      routine:objective,lease,localDate:"2026-11-20",
      provider:(async function*(){}) as never,
    });
    expect(scopedWeekSchedule).toHaveBeenCalledWith({weekStart:"2026-11-16"},
      {client:db,businessId:objective.businessId,ownerUserId:objective.ownerUserId});
    expect(readFinancialEvidence).toHaveBeenCalledWith({
      businessId:objective.businessId,ownerUserId:objective.ownerUserId,
      verifiedReadClient:db,
    },"2026-11-20",{horizonDays:14});
    expect(rpc).toHaveBeenCalledWith("u4_publish_objective_report",expect.anything());
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
    expect(watchTurn?.context.staffMessages).toBeUndefined();
    expect(watchTurn?.context.staffCoordinationRead).toBeUndefined();
    expect(watchTurn?.toolNames).not.toContain("get_staff_messages");
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
