import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {AgentProvider} from "@/lib/ai/agent/loop.server";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/ai/conversations/usage.server",()=>({ownerModelCallsLimit:()=>null}));
import {meteredInvestigationProvider} from "./investigationUsage.server";

const scope={businessId:"cafe-a",ownerUserId:"owner-a",threadId:"thread-a",
  sourceType:"operating_task" as const,sourceId:"task-1",leaseToken:"lease-a"};
const params={model:"gpt-6-luna",max_output_tokens:1200,store:false,
  input:[{role:"user",content:"Investigate the exact source"}]};
const signal=new AbortController().signal;
const db=(errorAt:string|null=null,message="")=>{
  const calls:Array<{name:string;args:Record<string,unknown>}>=[];
  const client={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
    calls.push({name,args});
    return {data:null,error:name===errorAt?{message}:null};
  })} as unknown as SupabaseClient;
  return {client,calls};
};
const completed=async function*(){
  yield {type:"response.completed",response:{
    model:"gpt-6-luna",usage:{input_tokens:100,output_tokens:20,
      input_tokens_details:{cached_tokens:0}},
  }};
};
describe("scheduled system-initiated paid model quota",()=>{
  it("reserves one owner-scoped attempt BEFORE provider transport and completes measured usage",async()=>{
    const d=db();let launched=0;
    const underlying=async function*(){
      expect(d.calls.map(x=>x.name)).toEqual(["supervisor_reserve_investigation_model_call"]);
      launched++;yield* completed();
    };
    const metered=meteredInvestigationProvider(d.client,scope,underlying as AgentProvider);
    const events=[];
    for await(const event of metered.provider(params as Parameters<AgentProvider>[0],signal))
      events.push(event);
    expect(launched).toBe(1);
    expect(events.map(e=>e.type)).toEqual(["response.completed"]);
    expect(metered.problem()).toBeNull();
    expect(d.calls.map(x=>x.name)).toEqual([
      "supervisor_reserve_investigation_model_call",
      "supervisor_complete_investigation_model_call",
    ]);
    expect(d.calls[0].args).toMatchObject({
      p_business_id:"cafe-a",p_owner_user_id:"owner-a",p_thread_id:"thread-a",
      p_source_type:"operating_task",p_source_id:"task-1",
      p_lease_token:"lease-a",p_owner_daily_cap:null,p_model:"gpt-6-luna",
      p_output_cap:1200,
    });
    expect(d.calls[1].args).toMatchObject({
      p_input_tokens:100,p_output_tokens:20,p_estimated_cost_micros:20,
    });
    expect(d.calls[0].args.p_attempt_id).toBe(d.calls[1].args.p_attempt_id);
  });
  it("bills the validated requested model when the provider completion omits its model name",async()=>{
    const d=db();
    const noModel=async function*(){
      yield {type:"response.completed",response:{usage:{input_tokens:100,
        output_tokens:20,input_tokens_details:{cached_tokens:0}}}};
    };
    const metered=meteredInvestigationProvider(d.client,scope,noModel as AgentProvider);
    for await(const _ of metered.provider(params as Parameters<AgentProvider>[0],signal)){}
    expect(metered.problem()).toBeNull();
    expect(d.calls.map(c=>c.name)).toEqual([
      "supervisor_reserve_investigation_model_call",
      "supervisor_complete_investigation_model_call",
    ]);
    expect(d.calls[1].args.p_model).toBe("gpt-6-luna");
  });
  it("failed or timed-out transports remain reserved and count as one attempt",async()=>{
    const d=db();let launched=0;
    const underlying=async function*(){
      launched++;throw new Error("provider disconnected");
      yield* completed();
    };
    const metered=meteredInvestigationProvider(d.client,scope,underlying as AgentProvider);
    await expect(async()=>{
      for await(const _ of metered.provider(params as Parameters<AgentProvider>[0],signal)){}
    }).rejects.toThrow("provider disconnected");
    expect(launched).toBe(1);
    expect(d.calls.map(x=>x.name)).toEqual(["supervisor_reserve_investigation_model_call"]);
  });
  it("the owner's exhausted quota blocks every provider call before transport",async()=>{
    const d=db("supervisor_reserve_investigation_model_call","owner_usage_limit_reached");
    let launched=0;
    const underlying=async function*(){launched++;yield* completed();};
    const metered=meteredInvestigationProvider(d.client,scope,underlying as AgentProvider);
    await expect(async()=>{
      for await(const _ of metered.provider(params as Parameters<AgentProvider>[0],signal)){}
    }).rejects.toThrow("owner_quota_reached");
    expect(metered.problem()).toBe("owner_quota_reached");
    expect(launched).toBe(0);
    expect(d.calls).toHaveLength(1);
  });
  it("a lost DB completion write prevents a verified owner report",async()=>{
    const d=db("supervisor_complete_investigation_model_call","unavailable");
    const metered=meteredInvestigationProvider(d.client,scope,completed as AgentProvider);
    await expect(async()=>{
      for await(const _ of metered.provider(params as Parameters<AgentProvider>[0],signal)){}
    }).rejects.toThrow("storage_failed");
    expect(metered.problem()).toBe("storage_failed");
    expect(d.calls.map(x=>x.name)).toHaveLength(2);
  });
});

it("meters hosted research through the same fenced ledger; missing tool tariff is not zero",async()=>{
 const d=db(),metered=meteredInvestigationProvider(d.client,scope,completed as AgentProvider);
 const old=process.env.SUPERVISOR_HOSTED_WEB_CALL_COST_MICROS;
 delete process.env.SUPERVISOR_HOSTED_WEB_CALL_COST_MICROS;
 try{
  const finish=await metered.reserve({...params,tools:[{type:"web_search"}]},"hosted_web");
  expect(d.calls.map(x=>x.name)).toEqual(["supervisor_reserve_investigation_model_call"]);
  const response={model:"gpt-6-luna",usage:{input_tokens:100,output_tokens:20},output:[{type:"web_search_call",id:"search-1",status:"completed"}]};
  await finish(response);
  expect(d.calls[1].args).toMatchObject({p_input_tokens:100,p_output_tokens:20,p_estimated_cost_micros:null});
  process.env.SUPERVISOR_HOSTED_WEB_CALL_COST_MICROS="10000";
  const next=await metered.reserve(params,"hosted_web");await next(response);
  expect(d.calls[3].args.p_estimated_cost_micros).toBe(10020);
  await expect(next(response)).rejects.toThrow("investigation_usage_completion_conflict");
 }finally{if(old===undefined)delete process.env.SUPERVISOR_HOSTED_WEB_CALL_COST_MICROS;else process.env.SUPERVISOR_HOSTED_WEB_CALL_COST_MICROS=old;}
});
