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
