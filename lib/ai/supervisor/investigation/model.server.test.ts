import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {z} from "zod";
import {requestInvestigation} from "./model.server";
import {INVESTIGATION_LIMITS} from "./protocol";

const completed=(data:unknown)=>new Response(JSON.stringify({status:"completed",
  usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(data)}]}]}));

describe("requestInvestigation output-token budget", ()=>{
  it("clamps each request's max_output_tokens to what remains of the turn's own backstop",async()=>{
    const bodies:Record<string,unknown>[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      bodies.push(JSON.parse(String(init.body)));
      return completed({x:"ok"});
    });
    const usage={model:"gpt-6-luna",modelCallCount:0,toolCallCount:0,inputTokens:0,
      outputTokens:INVESTIGATION_LIMITS.totalOutputTokens-800};
    await requestInvestigation({name:"supervisor_investigation_review",schema:z.strictObject({x:z.string()}),
      instructions:"",context:{},model:"gpt-6-luna",apiKey:"k",transport,usage,deadline:Date.now()+90000});
    // Only 800 tokens remain in the turn's budget; the per-call request must not
    // advertise the full 6000 cap, which could push the turn's total past its limit.
    expect(bodies[0].max_output_tokens).toBe(800);
  });

  it("still allows the full per-call cap when plenty of budget remains",async()=>{
    const bodies:Record<string,unknown>[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      bodies.push(JSON.parse(String(init.body)));
      return completed({x:"ok"});
    });
    const usage={model:"gpt-6-luna",modelCallCount:0,toolCallCount:0,inputTokens:0,outputTokens:0};
    await requestInvestigation({name:"supervisor_investigation_review",schema:z.strictObject({x:z.string()}),
      instructions:"",context:{},model:"gpt-6-luna",apiKey:"k",transport,usage,deadline:Date.now()+90000});
    expect(bodies[0].max_output_tokens).toBe(6000);
  });

  it("never drops the per-call request below a floor that could still succeed",async()=>{
    const bodies:Record<string,unknown>[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      bodies.push(JSON.parse(String(init.body)));
      return completed({x:"ok"});
    });
    const usage={model:"gpt-6-luna",modelCallCount:0,toolCallCount:0,inputTokens:0,
      outputTokens:INVESTIGATION_LIMITS.totalOutputTokens-10};
    await requestInvestigation({name:"supervisor_investigation_review",schema:z.strictObject({x:z.string()}),
      instructions:"",context:{},model:"gpt-6-luna",apiKey:"k",transport,usage,deadline:Date.now()+90000});
    expect(bodies[0].max_output_tokens).toBe(500);
  });
});

describe("requestInvestigation invalid-payload sub-reasons",()=>{
  const baseUsage=()=>({model:"gpt-6-luna",modelCallCount:0,toolCallCount:0,inputTokens:0,outputTokens:0});
  const schema=z.strictObject({x:z.string().min(2)});

  it("reports wrong_text_shape when the provider returns no output_text parts",async()=>{
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[]}]})));
    const onDiagnostic=vi.fn();
    await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({invalidPayloadReason:"wrong_text_shape"}));
  });

  it("reports unparseable_json for literally malformed JSON text",async()=>{
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[{type:"output_text",text:"{not json"}]}]})));
    const onDiagnostic=vi.fn();
    await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({invalidPayloadReason:"unparseable_json"}));
  });

  it("reports schema_mismatch with the failing field path when JSON parses but fails the zod contract",async()=>{
    const transport=vi.fn(async()=>completed({x:""}));
    const onDiagnostic=vi.fn();
    await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"schema_mismatch",schemaIssuePath:"x"}));
  });
});
