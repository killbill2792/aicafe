import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => ({ rpc }) }));
import { selectNextDurableRun } from "./repository.server";

const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => rpc.mockReset());

describe("existing durable worker SQL dispatch port", () => {
  it("reads a reserved ordinary candidate from the canonical RPC", async () => {
    rpc.mockResolvedValue({ data: { run_id: id, recovery: false }, error: null });
    expect(await selectNextDurableRun()).toEqual({ runId: id, recovery: false });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("supervisor_select_next_durable_run", {});
  });
  it("reads reserved reconciliation work without issuing another claim", async () => {
    rpc.mockResolvedValue({ data: { run_id: id, recovery: true }, error: null });
    expect(await selectNextDurableRun()).toEqual({ runId: id, recovery: true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("reports an empty or contended fleet as no candidate", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await selectNextDurableRun()).toBeNull();
  });
  it("fails closed on storage failure", async () => {
    rpc.mockResolvedValue({ data: { run_id: id, recovery: true }, error: { message: "unavailable" } });
    await expect(selectNextDurableRun()).rejects.toThrow("Supervisor durable run storage unavailable");
  });
  it("rejects malformed dispatch identities and missing recovery type", async () => {
    rpc.mockResolvedValueOnce({ data: { run_id: "other", recovery: false }, error: null })
      .mockResolvedValueOnce({ data: { run_id: id }, error: null });
    await expect(selectNextDurableRun()).rejects.toThrow();
    await expect(selectNextDurableRun()).rejects.toThrow();
  });
});

describe("canonical admin recovery finding",()=>{
  it("renders unresolved operational counts without model or private owner facts",async()=>{
    const {parseFindings,describeFinding}=await import("@/lib/admin/dataHealth");
    const row={kind:"supervisor_work_recovery",business_id:id,expired_leases:1,blocked_runs:2,
      retrying_investigations:3,failed_routines:4,stalled_runs:5};
    const parsed=parseFindings([row]);
    expect(parsed).toEqual({known:[row],unknown:0});
    expect(describeFinding(parsed.known[0],()=>"Fixture café")).toBe(
      "Fixture café: Supervisor recovery — 1 expired leases, 2 blocked runs, 3 retrying investigations, 4 failed routines, 5 stalled runs.");
  });
});


describe("the registered agent loop uses the durable provider reservation before every transport",()=>{
  const scope={businessId:id,ownerUserId:"00000000-0000-4000-8000-000000000002",
    threadId:"00000000-0000-4000-8000-000000000003",runId:"00000000-0000-4000-8000-000000000004",
    ownerMessageId:"00000000-0000-4000-8000-000000000005",jobId:"00000000-0000-4000-8000-000000000006",
    claimToken:"00000000-0000-4000-8000-000000000007"};
  const fixture=async(provider:import("@/lib/ai/agent/loop.server").AgentProvider,deny?:"reserve"|"complete",
    attachment?:{ownerImages?:readonly {mimeType:string;base64:string}[];ownerPdfs?:readonly {filename:string;base64:string}[];ownerEvidence?:readonly string[]})=>{
    const {runAgentTurn}=await import("@/lib/ai/agent/loop.server");
    const {withDurableProviderTurn,currentDurableUsageAccounting}=await import("./usage.server");
    const calls:Array<{name:string;args:Record<string,unknown>}>=[];
    const client={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
      calls.push({name,args});
      return {data:null,error:deny==="reserve"&&name.includes("reserve_durable")||
        deny==="complete"&&name.includes("complete_investigation")?{message:"storage unavailable"}:null};
    })} as unknown as import("@supabase/supabase-js").SupabaseClient;
    const authorized=vi.fn(async()=>{});
    vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
    try{
      const result=await withDurableProviderTurn({...scope,db:client,authorize:authorized,ownerDailyCap:null,
        budget:{maxElapsedMs:60000,maxModelCalls:6,maxToolCalls:8,maxInputTokens:60000,maxOutputTokens:7200}},
        async()=>{
          const turn=await runAgentTurn({ownerText:"Hello",...attachment,context:{timezone:"UTC",asOf:"2026-11-18",
            locale:"en",tools:{}} as import("@/lib/ai/agent/tools").AgentToolContext,
            provider:async function*(params,signal){
              expect(calls.at(-1)?.name).toBe("supervisor_reserve_durable_model_call");
              yield* provider(params,signal);
            }});
          return {turn,accounting:currentDurableUsageAccounting(scope,turn.usage.modelCalls)};
        });
      return {...result,calls,authorized};
    }finally{vi.unstubAllEnvs();}
  };
  const complete:import("@/lib/ai/agent/loop.server").AgentProvider=async function*(){
    yield {type:"response.output_text.delta",delta:"Here is the verified answer."};
    yield {type:"response.completed",response:{model:"gpt-6-luna",
      usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:0}}}};
  };
  it.each(["provider_timeout","HTTP_429","HTTP_503","incomplete_stream"])(
    "persists a failed %s attempt before the existing bounded final retry",async(fault)=>{
      let launches=0;
      const result=await fixture(async function*(params,signal){
        launches++;
        if(launches===1){
          if(fault==="incomplete_stream")return;
          throw new Error(fault);
        }
        yield* complete(params,signal);
      });
      expect(launches).toBe(2);
      expect(result.calls.map(x=>x.name)).toEqual(["supervisor_reserve_durable_model_call",
        "supervisor_reserve_durable_model_call","supervisor_complete_investigation_model_call"]);
      const first=result.calls[0].args,second=result.calls[1].args;
      expect(first).toMatchObject({p_run_id:scope.runId,p_claim_token:scope.claimToken,
        p_business_id:scope.businessId,p_owner_message_id:scope.ownerMessageId,p_job_id:scope.jobId,
        p_model:"gpt-6-luna",p_max_calls:6,p_max_cost:null,p_owner_daily_cap:null});
      expect(first.p_attempt_id).not.toBe(second.p_attempt_id);
      expect(result.calls[2].args.p_attempt_id).toBe(second.p_attempt_id);
      expect(result.accounting).toEqual({runId:scope.runId,attemptIds:[first.p_attempt_id,second.p_attempt_id]});
      expect(result.authorized).toHaveBeenCalledTimes(2);
    });
  it.each(["image","pdf"] as const)("reserves decoded %s context independently of binary transport bytes",async(kind)=>{
    const base64=Buffer.alloc(300*1024,7).toString("base64");
    const attachment=kind==="image"?{ownerImages:[{mimeType:"image/jpeg",base64}]}:
      {ownerPdfs:[{filename:"invoice.pdf",base64}]};
    let launched=0;
    const result=await fixture(async function*(params,signal){
      launched++;
      // Real outgoing body is unchanged. The private accounting copy alone
      // excludes encoded attachment bytes, never text or provider inputs.
      expect(JSON.stringify(params)).toContain(base64);
      yield* complete(params,signal);
    },undefined,attachment);
    expect(launched).toBe(1);
    expect(result.calls[0].args.p_input_upper).toBe(272000);
    expect(result.calls[1].name).toBe("supervisor_complete_investigation_model_call");
    expect(result.turn.endReason).toBe("complete");
  });
  it("does not discount oversized ordinary text even when an inline attachment is present",async()=>{
    const base64=Buffer.alloc(300*1024,7).toString("base64");
    let launched=0;
    const result=await fixture(async function*(params,signal){
      launched++;yield* complete(params,signal);
    },undefined,{ownerImages:[{mimeType:"image/jpeg",base64}],
      ownerEvidence:["x".repeat(300000)]});
    expect(launched).toBe(0);
    expect(result.calls).toHaveLength(0);
    expect(result.turn.endReason).toBe("provider_error");
  });
  it("does not treat an unrecognized data URL as discounted binary evidence",async()=>{
    const base64=Buffer.alloc(300*1024,7).toString("base64");
    let launched=0;
    const result=await fixture(async function*(params,signal){
      launched++;yield* complete(params,signal);
    },undefined,{ownerImages:[{mimeType:"text/plain",base64}]});
    expect(launched).toBe(0);
    expect(result.calls).toHaveLength(0);
    expect(result.turn.endReason).toBe("provider_error");
  });
  it("refuses any provider transport or fallback after reservation persistence fails",async()=>{
    let launches=0;
    const result=await fixture(async function*(params,signal){launches++;yield* complete(params,signal);},"reserve");
    expect(launches).toBe(0);
    expect(result.calls.map(x=>x.name)).toEqual(["supervisor_reserve_durable_model_call"]);
    expect(result.turn.usage.modelCalls).toBe(0);
    expect(result.turn.endReason).toBe("provider_error");
    expect(result.accounting).toBeNull();
  });
  it("does not refund, retry or report a completed response after completion ACK loss",async()=>{
    let launches=0;
    const result=await fixture(async function*(params,signal){launches++;yield* complete(params,signal);},"complete");
    expect(launches).toBe(1);
    expect(result.calls.map(x=>x.name)).toEqual(["supervisor_reserve_durable_model_call","supervisor_complete_investigation_model_call"]);
    expect(result.turn.endReason).toBe("provider_error");
    expect(result.turn.text).toBe("");
    expect(result.accounting?.attemptIds).toEqual([result.calls[0].args.p_attempt_id]);
  });
});
