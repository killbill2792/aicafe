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

  it("tags which output item types were present when there was no message item at all",async()=>{
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"reasoning"}]})));
    const onDiagnostic=vi.fn();
    await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"wrong_text_shape",outputItemTypes:["reasoning"],
        messagePartTypes:undefined,outputTextPartCount:0}));
  });

  it("tags a refusal content part instead of an output_text part",async()=>{
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},
      output:[{type:"message",content:[{type:"refusal",refusal:"cannot comply"}]}]})));
    const onDiagnostic=vi.fn();
    await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"wrong_text_shape",outputItemTypes:["message"],
        messagePartTypes:["refusal"],outputTextPartCount:0}));
  });

  it("counts a too-long concatenated text as wrong_text_shape even when every part parses alone",async()=>{
    const longHalf="x".repeat(9001);
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",
        content:[{type:"output_text",text:longHalf},{type:"output_text",text:longHalf}]}]})));
    const onDiagnostic=vi.fn();
    await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"wrong_text_shape",outputItemTypes:["message"],
        messagePartTypes:["output_text"],outputTextPartCount:2}));
  });

  it("concatenates a JSON answer split across multiple output_text parts, in order, instead of rejecting it",async()=>{
    // Production evidence: the Responses API legitimately splits a long structured
    // answer across several output_text parts within the same message.
    const whole=JSON.stringify({x:"reassembled answer"});
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:whole.slice(0,10)},
        {type:"output_text",text:whole.slice(10)},
      ]}]})));
    const onDiagnostic=vi.fn();
    const result=await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",
      context:{},model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(result).toEqual({x:"reassembled answer"});
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it("reports unparseable_json for literally malformed JSON text, with its length and error position",async()=>{
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[{type:"output_text",text:"{not json"}]}]})));
    const onDiagnostic=vi.fn();
    await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"unparseable_json",outputTextPartCount:1,jsonTextLength:9}));
  });

  it("reports that the first part alone parses when later parts are what broke the concatenation",async()=>{
    // The first part is a complete, independently valid JSON answer; a second
    // part of trailing text makes the CONCATENATED string unparseable even
    // though the real answer was already complete on its own.
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:JSON.stringify({x:"ok"})},
        {type:"output_text",text:" trailing"},
      ]}]})));
    const onDiagnostic=vi.fn();
    await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"unparseable_json",outputTextPartCount:2,firstPartAloneParses:true}));
  });

  it("reports that the first part alone does NOT parse when the JSON is genuinely fragmented across parts",async()=>{
    const whole=JSON.stringify({x:"ok"});
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:whole.slice(0,3)},
        {type:"output_text",text:"garbage that does not continue the JSON"},
      ]}]})));
    const onDiagnostic=vi.fn();
    await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"unparseable_json",outputTextPartCount:2,firstPartAloneParses:false}));
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
