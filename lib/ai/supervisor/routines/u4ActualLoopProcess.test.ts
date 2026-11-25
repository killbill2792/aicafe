/** Disposable U4 process boundary. This Vitest file is invoked in a CHILD OS
 * process by routines.db.test.ts. Normal CI shards skip it; the migrated DB
 * suite opts in and SIGKILLs the child after a real registered model/tool
 * execution committed a fenced tool_complete checkpoint.
 *
 * The provider is recorded (zero paid calls), but runAgentTurn, query_data,
 * the persisted source row, model-call reservations, and the original U4
 * checkpoint/report RPCs execute. Genuine provider restart remains a
 * separately owner-authorized Task17C acceptance requirement.
 */
import {writeFileSync} from "node:fs";
import {Client} from "pg";
import {randomUUID} from "node:crypto";
import {runU3Sql} from "@/lib/ai/agent/tools/u3SqlResearch.server";
import {expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/ai/agent/tools/u3SqlResearch.server",async importOriginal=>({
 ...await importOriginal<typeof import("@/lib/ai/agent/tools/u3SqlResearch.server")>(),u3SqlConfigured:()=>true,runU3Sql:vi.fn(),
}));
import {runAgentTurn,type AgentProvider} from "@/lib/ai/agent/loop.server";
import type {AgentToolContext} from "@/lib/ai/agent/tools";
import {withWorkerBudget} from "@/lib/ai/supervisor/runs/usage.server";
import {meteredInvestigationProvider} from "./investigationUsage.server";
import {routineObjectiveCheckpoint,verifyObjectiveTurn} from "./objective.server";

const run=process.env.U4_ACTUAL_LOOP_CHILD==="1"?it:it.skip;
const allowedRpc=new Set([
  "u4_routine_lease_active","u4_checkpoint_model_step","u4_store_research_read","u4_load_research_reads",
  "supervisor_reserve_investigation_model_call",
  "supervisor_complete_investigation_model_call",
  "u4_publish_objective_report",
]);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
run("survives actual recorded model and registered source tool across SIGKILL",async()=>{
  const env=process.env;
  const raw=env.SUPERVISOR_ROUTINES_DB_URL??"";
  const target=raw?new URL(raw):null;
  if(!target||!["localhost","127.0.0.1"].includes(target.hostname)||
     target.port!=="54322"||target.pathname!=="/postgres"||
     env.SUPERVISOR_ROUTINES_DB_SANDBOX_ONLY!=="1"||
     !["crash","resume"].includes(env.U4_PROCESS_MODE??"")||
     !env.U4_PROCESS_MARKER||
     ![env.U4_CRASH_BUSINESS,env.U4_CRASH_ROUTINE,env.U4_CRASH_RUN,
       env.U4_CRASH_LEASE,env.U4_CRASH_OWNER,env.U4_CRASH_THREAD].every(x=>
         typeof x==="string"&&uuid.test(x)))
    throw Error("u4_disposable_actual_loop_preflight_failed");
  const mode=env.U4_PROCESS_MODE!;
  // Test-only encryption key in an explicitly disposable, zero-provider child.
  env.SUPABASE_SERVICE_ROLE_KEY??="disposable-u4-research-checkpoint-test-key";
  const businessId=env.U4_CRASH_BUSINESS!;
  const ownerUserId=env.U4_CRASH_OWNER!;
  const threadId=env.U4_CRASH_THREAD!;
  const routineId=env.U4_CRASH_ROUTINE!;
  const runId=env.U4_CRASH_RUN!;
  const leaseToken=env.U4_CRASH_LEASE!;
  const db=new Client({connectionString:raw});
  await db.connect();
  try{
    await db.query("select set_config('request.jwt.claim.role','service_role',false)");
    await db.query("set role service_role");
    const routine={id:routineId,businessId,ownerUserId,threadId,
      executionMode:"objective" as const,objectiveText:"Review actual sales",
      revision:3};
    const lease={runId,leaseToken,revision:3};
    // PostgREST-equivalent adapter around ACTUAL persisted PostgreSQL functions.
    // The only permitted RPC names are those in the existing U4 work path.
    const rpc=async(name:string,args:Record<string,unknown>)=>{
      try{
        if(!allowedRpc.has(name))throw Error("u4_child_unexpected_rpc:"+name);
        const entries=Object.entries(args);
        const names=entries.map(([key],i)=>{
          if(!/^p_[a-z][a-z0-9_]*$/u.test(key))throw Error("u4_bad_rpc_argument");
          return key+" => $"+(i+1);
        }).join(",");
        const observed=await db.query(
          "select to_jsonb(public."+name+"("+names+")) as data",
          entries.map(([,value])=>value));
        const data=observed.rows[0]?.data;
        // This marker is emitted only AFTER an actual query_data tool result
        // reached the production checkpoint and the DB acknowledged commit.
        if(name==="u4_store_research_read"&&
           data===true&&mode==="crash"){
          writeFileSync(env.U4_PROCESS_MARKER!,"tool_complete_committed\n",{flag:"wx"});
          await new Promise<never>(()=>{});
        }
        return {data,error:null};
      }catch(error){
        return {data:null,error:{message:String(error)}};
      }
    };
    const scopedRead=()=>{
      const where:Record<string,unknown>={};
      type CheckpointChain={
        select:(columns:string)=>CheckpointChain;
        eq:(key:string,value:unknown)=>CheckpointChain;
        maybeSingle:()=>Promise<{data:Record<string,unknown>|null;error:null}>;
      };
      const chain:CheckpointChain={
        select:(_columns:string)=>chain,
        eq:(key:string,value:unknown)=>{where[key]=value;return chain;},
        maybeSingle:async()=>{
          if(where.business_id!==businessId||
             where.routine_id!==routineId||where.run_id!==runId)
            throw Error("u4_checkpoint_cross_scope");
          const observed=await db.query("select u4_checkpoint from "+
            "public.supervisor_routine_occurrences where "+
            "business_id=$1 and routine_id=$2 and run_id=$3",
            [businessId,routineId,runId]);
          return {data:observed.rows[0]??null,error:null};
        },
      };
      return chain;
    };
    const port={rpc,from:(table:string)=>{
      if(table!=="supervisor_routine_occurrences")
        throw Error("u4_child_unexpected_reader");
      return scopedRead();
    }};
    const assertLease=async()=>{
      const result=await rpc("u4_routine_lease_active",{
        p_business_id:businessId,p_routine_id:routineId,
        p_run_id:runId,p_lease_token:leaseToken,
      });
      if(result.error||result.data!==true)throw Error("u4_real_loop_lease_lost");
    };
    const checkpoint=routineObjectiveCheckpoint(port as never,{
      routine:routine as never,lease:lease as never,assertLease,
    });
    if(mode==="resume"){
      const resumed=await checkpoint.resumeContext?.();
      expect(resumed).toContain("RESUMED ORIGINAL ROUTINE OCCURRENCE");
      expect(resumed).toContain("tool_complete");
      expect(resumed).not.toContain("4875");
    }
    // This process-boundary test mocks only SQL transport, reading the
    // real disposable row after verifying the original live lease. The U3
    // migrated security suite independently exercises actual SQL admission.
    const statement="SELECT net_sales_cents,orders_count FROM daily_rollups WHERE business_date=$1";
    vi.mocked(runU3Sql).mockImplementation(async(_ctx,raw)=>{
      if(mode==="resume")throw Error("restored_receipt_must_not_repeat_source_read");
      await assertLease();
      expect(raw).toMatchObject({sql:statement,parameters:["2026-11-20"]});
      const rows=await db.query("SELECT net_sales_cents,orders_count FROM public.daily_rollups WHERE business_id=$1 AND business_date=$2",[businessId,"2026-11-20"]);
      return {source:"u3_canonical_research",period:{from:"2026-11-20",to:"2026-11-20"},missing:[],rows:rows.rows,
        truncated:false,page_complete:true,evidence:{scope:"verified_owner_cafe_lease",authority:"approved_logical_source",
          receipt_id:randomUUID(),query_fingerprint:"a".repeat(64),catalog_version:"a".repeat(16),relation_names:["daily_rollups"],column_units:{net_sales_cents:"cents",orders_count:"count"}}} as unknown as Awaited<ReturnType<typeof runU3Sql>>;
    });
    const context={
      locale:"en",timezone:"America/Los_Angeles",currency:"USD",
      asOf:"2026-11-21",canonicalData:async()=>({businessId,db:{} as never,aggregateOnly:true}),
      tools:{
        getSalesTrend:async()=>{throw Error("retired_report_called");},
        getProfitability:async()=>({available:false}),
        getMenuCatalog:async()=>({available:false}),
      },
    } as unknown as AgentToolContext;
    let requests=0;
    const completed={type:"response.completed",response:{
      model:"gpt-6-luna",status:"completed",
      usage:{input_tokens:30,output_tokens:12,input_tokens_details:{cached_tokens:0}},
    }};
    const recorded:AgentProvider=async function*(){
      if(requests++===0&&mode==="crash"){
        yield {type:"response.output_item.done",item:{
          type:"function_call",name:"query_data",call_id:"u4-durable-sales",
          arguments:JSON.stringify({sql:statement,parameters:["2026-11-20"],date_from:"2026-11-20",date_to:"2026-11-20",limit:null}),
        }} as never;
      }else{
        yield {type:"response.output_text.delta",
          delta:"Verified recorded sales evidence warrants an owner review."} as never;
      }
      yield completed as never;
    };
    const metered=meteredInvestigationProvider(port as never,{
      businessId,ownerUserId,threadId,sourceType:"routine",
      sourceId:runId,leaseToken,
    },recorded,1200);
    const turn=await withWorkerBudget({
      maxElapsedMs:45_000,maxModelCalls:4,maxToolCalls:3,
      maxInputTokens:72_000,maxOutputTokens:2400,
    },()=>runAgentTurn({
      ownerText:"Review the actual café sales on this original routine run.",
      serviceOrigin:true,toolNames:["query_data"],
      context,provider:metered.provider,checkpoint,
    }));
    expect(metered.problem()).toBeNull();
    const observed=turn.toolInvocations?.find(x=>x.name==="query_data");
    expect(Number((observed?.result.rows as Array<{net_sales_cents:unknown}>|undefined)?.[0]?.net_sales_cents)).toBe(4875);
    expect(runU3Sql).not.toHaveBeenCalled();
    expect(turn.usage.toolCalls).toBe(0);
    const verified=verifyObjectiveTurn(turn,routine as never);
    expect(verified.sourceDomains).toContain("recorded_sales");
    if(mode!=="resume")throw Error("u4_crash_process_should_have_been_killed");
    const proof={
      sources:verified.sourceRefs.map(x=>({
        source:"cafe_state",identifier:x.tool,originalSource:x.source,
        domain:x.domain,view:x.view,relations:x.relations,period:x.period,
        evidenceDigest:x.evidenceDigest,asOf:"2026-11-21",
      })),
      sourceCount:verified.sourceCount,sourceDomains:verified.sourceDomains,
      quality:"verified",missing:verified.missing,
      externalEffects:"not_attempted",
    };
    await assertLease();
    const report=await rpc("u4_publish_objective_report",{
      p_business_id:businessId,p_routine_id:routineId,
      p_run_id:runId,p_lease_token:leaseToken,
      p_report:verified.report,p_attention:verified.attention,
      p_proof:proof,p_now:new Date().toISOString(),
    });
    expect(report.error).toBeNull();
    expect(report.data).toBe(true);
    writeFileSync(env.U4_PROCESS_MARKER!,"resumed_and_published\n",{flag:"w"});
  }finally{await db.end();}
},65_000);
