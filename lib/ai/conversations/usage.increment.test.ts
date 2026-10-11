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
    }
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
