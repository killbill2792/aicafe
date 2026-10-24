import {beforeEach,describe,expect,it,vi} from "vitest";
const memory=vi.hoisted(()=>({events:new Map<string,{
  input:number;output:number;models:number;tools:number;cost:number|null}>(),increments:[] as Array<Record<string,unknown>>}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({
  rpc:async(name:string,params:Record<string,unknown>)=>{
    if(name!=="record_supervisor_usage_increment") throw Error("Wrong usage RPC");
    memory.increments.push(params);
    const id=String(params.p_owner_message_id), prior=memory.events.get(id);
    const cost=params.p_estimated_cost_micros as number|null;
    memory.events.set(id,{
      input:(prior?.input??0)+Number(params.p_input_tokens),
      output:(prior?.output??0)+Number(params.p_output_tokens),
      models:(prior?.models??0)+Number(params.p_model_call_count),
      tools:(prior?.tools??0)+Number(params.p_tool_call_count),
      cost:prior?(prior.cost===null||cost===null?null:prior.cost+cost):cost,
    });
    return {error:null};
  },
})}));
import {recordSupervisorUsage} from "./usage.server";
import {readFileSync} from "node:fs";
describe("Retry usage accounting (atomic SQL contract + mocked RPC)",()=>{
  beforeEach(()=>{memory.events.clear();memory.increments.length=0;});
  it("adds failed attempt and successful retry, never replaces earlier usage",async()=>{
    const oldIn=process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS;
    const oldOut=process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS;
    const oldModel=process.env.SUPERVISOR_OPENAI_MODEL;
    process.env.SUPERVISOR_OPENAI_MODEL="gpt-6-luna";
    process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS="1";
    process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS="2";
    const params={scope:{businessId:"b",ownerUserId:"o"},threadId:"t",ownerMessageId:"same-key"};
    try{
      await recordSupervisorUsage({...params,usage:{model:"gpt-6-luna",inputTokens:100,outputTokens:50,
        modelCallCount:1,toolCallCount:1}});
      await recordSupervisorUsage({...params,usage:{model:"gpt-6-luna",inputTokens:200,outputTokens:80,
        modelCallCount:2,toolCallCount:2}});
      expect(memory.events.get("same-key")).toEqual({input:300,output:130,models:3,tools:3,cost:560});
      expect(memory.increments).toHaveLength(2);
      expect(memory.increments[1]).toMatchObject({p_owner_message_id:"same-key",
        p_input_tokens:200,p_output_tokens:80});
    }finally{
      if(oldIn===undefined)delete process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS;
      else process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS=oldIn;
      if(oldOut===undefined)delete process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS;
      else process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS=oldOut;
      if(oldModel===undefined)delete process.env.SUPERVISOR_OPENAI_MODEL;
      else process.env.SUPERVISOR_OPENAI_MODEL=oldModel;
    }
  });
  it("does not apply Luna token rates to fallback or unknown model usage",async()=>{
    const keys=["SUPERVISOR_OPENAI_MODEL","SUPERVISOR_OPENAI_FALLBACK_MODEL",
      "SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS","SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS",
      "SUPERVISOR_FALLBACK_INPUT_USD_PER_MILLION_TOKENS",
      "SUPERVISOR_FALLBACK_OUTPUT_USD_PER_MILLION_TOKENS"] as const;
    const previous=keys.map(k=>process.env[k]);
    try{
      process.env.SUPERVISOR_OPENAI_MODEL="gpt-6-luna";
      process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL="gpt-4.1-mini";
      process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS="100";
      process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS="200";
      delete process.env.SUPERVISOR_FALLBACK_INPUT_USD_PER_MILLION_TOKENS;
      delete process.env.SUPERVISOR_FALLBACK_OUTPUT_USD_PER_MILLION_TOKENS;
      const params={scope:{businessId:"b",ownerUserId:"o"},threadId:"t"};
      await recordSupervisorUsage({...params,ownerMessageId:"fallback-no-rates",
        usage:{model:"gpt-4.1-mini",inputTokens:100,outputTokens:20,modelCallCount:2,toolCallCount:1}});
      expect(memory.increments.at(-1)).toMatchObject({
        p_model:"gpt-4.1-mini",p_input_tokens:100,p_output_tokens:20,p_estimated_cost_micros:null,
      });
      await recordSupervisorUsage({...params,ownerMessageId:"unknown-snapshot",
        usage:{model:"gpt-4.1-mini-2025-04-14",inputTokens:100,outputTokens:20,
          modelCallCount:1,toolCallCount:0}});
      expect(memory.increments.at(-1)).toMatchObject({p_model:"gpt-4.1-mini-2025-04-14",
        p_estimated_cost_micros:null});
      process.env.SUPERVISOR_FALLBACK_INPUT_USD_PER_MILLION_TOKENS="0.5";
      process.env.SUPERVISOR_FALLBACK_OUTPUT_USD_PER_MILLION_TOKENS="2";
      await recordSupervisorUsage({...params,ownerMessageId:"fallback-priced",
        usage:{model:"gpt-4.1-mini",inputTokens:100,outputTokens:20,modelCallCount:2,toolCallCount:1}});
      expect(memory.increments.at(-1)).toMatchObject({
        p_model:"gpt-4.1-mini",p_estimated_cost_micros:null,
      });
      await recordSupervisorUsage({...params,ownerMessageId:"luna-priced",
        usage:{model:"gpt-6-luna",inputTokens:100,outputTokens:20,modelCallCount:2,toolCallCount:1}});
      expect(memory.increments.at(-1)).toMatchObject({p_model:"gpt-6-luna",
        p_estimated_cost_micros:14000});
    }finally{
      keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});
    }
  });
  it("records the full bounded investigation including independent review",async()=>{
    await recordSupervisorUsage({scope:{businessId:"b",ownerUserId:"o"},threadId:"t",
      ownerMessageId:"investigation",usage:{model:"gpt-6-luna",inputTokens:1200,outputTokens:800,
        modelCallCount:8,toolCallCount:5}});
    expect(memory.increments.at(-1)).toMatchObject({p_model_call_count:8,p_tool_call_count:5});
    const sql=readFileSync("supabase/migrations/20261017000072_supervisor_investigation_usage.sql","utf8");
    expect(sql).toContain("p_model_call_count>8");
    expect(sql).toContain("p_tool_call_count>5");
    expect(sql).toContain("FROM PUBLIC,anon,authenticated");
    expect(sql).toContain("TO service_role");
  });
  it("migration 39 uses atomic conflict increment and service-role authorization only",()=>{
    const sql=readFileSync("supabase/migrations/20261010000039_supervisor_loop_usage.sql","utf8");
    expect(sql).toContain("ON CONFLICT (owner_message_id) DO UPDATE");
    expect(sql).toContain("input_tokens=usage.input_tokens+EXCLUDED.input_tokens");
    expect(sql).toContain("output_tokens=usage.output_tokens+EXCLUDED.output_tokens");
    expect(sql).toContain("model_call_count=usage.model_call_count+EXCLUDED.model_call_count");
    expect(sql).toContain("tool_call_count=usage.tool_call_count+EXCLUDED.tool_call_count");
    expect(sql).toContain("TO service_role");
    expect(sql).toContain("FROM PUBLIC,anon,authenticated");
    expect(sql).toContain("'partial', 'unavailable'");
  });
});
