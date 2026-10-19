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

describe("nested review budget reservation",()=>{
  it("never retries a calendar/privacy gate into the two final answer-review slots",async()=>{
    const usage={model:"gpt-6-luna",modelCallCount:5,toolCallCount:2,inputTokens:0,outputTokens:0};
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:"malformed gate output"},
      ]}]})));
    const result=await requestInvestigation({name:"supervisor_public_query_review",
      schema:z.strictObject({safe:z.boolean()}),instructions:"",context:{},apiKey:"k",
      model:usage.model,usage,transport,deadline:Date.now()+90000,reserveModelCalls:2});
    expect(result).toBeNull();
    expect(usage.modelCallCount).toBe(6);
    expect(transport).toHaveBeenCalledTimes(1);
    // No second review attempt can steal the model calls reserved for answer
    // generation and independent evidence audit.
    const blocked=await requestInvestigation({name:"supervisor_calendar_context_review",
      schema:z.strictObject({verdict:z.enum(["applies","unrelated","ambiguous"])}),
      instructions:"",context:{},apiKey:"k",model:usage.model,usage,transport,
      deadline:Date.now()+90000,reserveModelCalls:2});
    expect(blocked).toBeNull();expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("provider deadline attribution",()=>{
  it("does not mistake an ordinary provider timeout for a capped selection window",async()=>{
    vi.useFakeTimers();
    try{
      const transport=vi.fn(async()=>new Promise<Response>(()=>{}));
      const usage=()=>({model:"gpt-6-luna",modelCallCount:0,toolCallCount:0,
        inputTokens:0,outputTokens:0});
      const ordinary=requestInvestigation({name:"supervisor_investigation_step",
        schema:z.strictObject({x:z.string()}),instructions:"",context:{},model:"gpt-6-luna",
        apiKey:"k",transport,usage:usage(),deadline:Date.now()+INVESTIGATION_LIMITS.providerTimeoutMs+500,
        selectionBudgetDeadline:true}).catch(e=>e);
      await vi.advanceTimersByTimeAsync(INVESTIGATION_LIMITS.providerTimeoutMs+1);
      expect(await ordinary).toMatchObject({category:"provider_timeout",providerErrorCode:undefined});
      const capped=requestInvestigation({name:"supervisor_investigation_step",
        schema:z.strictObject({x:z.string()}),instructions:"",context:{},model:"gpt-6-luna",
        apiKey:"k",transport,usage:usage(),deadline:Date.now()+2500,
        selectionBudgetDeadline:true}).catch(e=>e);
      await vi.advanceTimersByTimeAsync(2501);
      expect(await capped).toMatchObject({category:"provider_timeout",
        providerErrorCode:"investigation_selection_deadline"});
    }finally{vi.useRealTimers();}
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
        messagePartTypes:undefined,outputTextPartCount:0,jsonTextLength:0}));
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

  it("counts a too-long concatenated text as wrong_text_shape even when every part parses alone, and still reports the full bundle",async()=>{
    const longHalf="x".repeat(9001);
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",
        content:[{type:"output_text",text:longHalf},{type:"output_text",text:longHalf}]}]})));
    const onDiagnostic=vi.fn();
    await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    // Every currently-known-safe signal is attached here too, even though the
    // category is wrong_text_shape, not unparseable_json: a bare "x" repeated
    // is not valid JSON at any prefix length, so validPrefixPartCount is 0.
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"wrong_text_shape",outputItemTypes:["message"],
        messagePartTypes:["output_text"],outputTextPartCount:2,jsonTextLength:18002,
        validPrefixPartCount:0}));
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

  it("accepts a complete, schema-valid 1-part JSON prefix instead of discarding it over trailing noise",async()=>{
    // Production evidence: the provider can emit a complete, correct answer and
    // then trailing noise (observed as a likely repeat of its own answer) that
    // breaks the full concatenation. Discarding a verified-valid answer and
    // forcing a retry is strictly worse than using it. Only true for
    // supervisor_investigation_step: see the dedicated test below proving the
    // semantic review/authorization gates never get this leniency.
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:JSON.stringify({x:"ok"})},
        {type:"output_text",text:" trailing"},
      ]}]})));
    const onDiagnostic=vi.fn();
    const result=await requestInvestigation({name:"supervisor_investigation_step",schema,instructions:"",
      context:{},model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(result).toEqual({x:"ok"});
    // Still recorded for observability, but with no category/invalidPayloadReason:
    // this path never retries or degrades the turn, so it is not an error.
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {outputTextPartCount:2,validPrefixPartCount:1,validPrefixMatchesSchema:true}));
    expect(onDiagnostic.mock.calls[0][0].category).toBeUndefined();
    expect(onDiagnostic.mock.calls[0][0].invalidPayloadReason).toBeUndefined();
  });

  it("recovers production-style duplicated JSON even when both copies share a single output_text part",async()=>{
    const valid=JSON.stringify({x:"the first validated step"});
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:valid+valid},
        {type:"output_text",text:" trailing generation"},
      ]}]})));
    const onDiagnostic=vi.fn();
    const usage=baseUsage();
    const result=await requestInvestigation({name:"supervisor_investigation_step",schema,
      instructions:"",context:{},model:"gpt-6-luna",apiKey:"k",transport,usage,
      deadline:Date.now()+90000,onDiagnostic});
    expect(result).toEqual({x:"the first validated step"});
    expect(usage.modelCallCount).toBe(1);expect(transport).toHaveBeenCalledTimes(1);
    // No entire output_text part is a JSON prefix; recovery scans root
    // boundaries, rather than losing an otherwise-valid instruction.
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      validPrefixPartCount:0,outputTextPartCount:2}));
    expect(onDiagnostic.mock.calls[0][0].category).toBeUndefined();
  });

  it("recovers a JSON root split inside parts and duplicated within the last part",async()=>{
    const valid=JSON.stringify({x:"validated instruction"});
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:valid.slice(0,7)},
        {type:"output_text",text:valid.slice(7)+valid},
      ]}]})));
    const result=await requestInvestigation({name:"supervisor_investigation_step",schema,
      instructions:"",context:{},model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),
      deadline:Date.now()+90000});
    expect(result).toEqual({x:"validated instruction"});
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects a broken first object instead of skipping to a later valid instruction",async()=>{
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:'{"x":broken}'+JSON.stringify({x:"later"})},
      ]}]})));
    const result=await requestInvestigation({name:"supervisor_investigation_step",schema,
      instructions:"",context:{},model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),
      deadline:Date.now()+90000});
    expect(result).toBeNull();expect(transport).toHaveBeenCalledTimes(2);
  });

  it("never accepts a recovered prefix for the public-query privacy authorization gate, even when valid and schema-matching",async()=>{
    // supervisor_public_query_review's {safe:true} directly authorizes sending
    // the owner's clause to an external search provider. An authorization gate
    // must fail closed on ANY malformed output, never lenient-accept a verdict
    // recovered from a response that was not entirely clean.
    const privacySchema=z.strictObject({safe:z.boolean()});
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:JSON.stringify({safe:true})},
        {type:"output_text",text:" trailing"},
      ]}]})));
    const onDiagnostic=vi.fn();
    const result=await requestInvestigation({name:"supervisor_public_query_review",schema:privacySchema,
      instructions:"",context:{},model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),
      deadline:Date.now()+90000,onDiagnostic});
    expect(result).toBeNull();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"unparseable_json",validPrefixPartCount:1,validPrefixMatchesSchema:true}));
  });

  it("never accepts a recovered prefix for the independent evidence/completeness review gate, even when valid and schema-matching",async()=>{
    // supervisor_investigation_review's {supported,complete} is the independent
    // evidence/coverage approval runInvestigationTurn uses to decide whether to
    // publish an answer. A truncated-but-structurally-valid verdict here is not
    // proof the model's full semantic review actually completed cleanly, so
    // this gate must keep failing closed like every other semantic review.
    const reviewSchema=z.strictObject({supported:z.boolean(),complete:z.boolean()});
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:JSON.stringify({supported:true,complete:true})},
        {type:"output_text",text:" trailing"},
      ]}]})));
    const onDiagnostic=vi.fn();
    const result=await requestInvestigation({name:"supervisor_investigation_review",schema:reviewSchema,
      instructions:"",context:{},model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),
      deadline:Date.now()+90000,onDiagnostic});
    expect(result).toBeNull();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"unparseable_json",validPrefixPartCount:1,validPrefixMatchesSchema:true}));
  });

  it("never accepts a recovered prefix for the calendar-context review gate, even when valid and schema-matching",async()=>{
    // supervisor_calendar_context_review's verdict binds whether a remembered
    // date correction applies; the same leniency here could bind an incorrect
    // date from an unclean response, so it keeps the same fail-closed behavior.
    const calendarSchema=z.strictObject({verdict:z.enum(["applies","unrelated","ambiguous"])});
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:JSON.stringify({verdict:"applies"})},
        {type:"output_text",text:" trailing"},
      ]}]})));
    const onDiagnostic=vi.fn();
    const result=await requestInvestigation({name:"supervisor_calendar_context_review",schema:calendarSchema,
      instructions:"",context:{},model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),
      deadline:Date.now()+90000,onDiagnostic});
    expect(result).toBeNull();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"unparseable_json",validPrefixPartCount:1,validPrefixMatchesSchema:true}));
  });

  it("never accepts a valid-JSON prefix that fails the schema contract, even when one exists",async()=>{
    // The first part is syntactically valid JSON but violates the schema (x
    // too short); a trailing part breaks the full concatenation. Confirms the
    // recovery path only accepts a prefix that is BOTH valid JSON AND schema-valid.
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:JSON.stringify({x:""})},
        {type:"output_text",text:" trailing"},
      ]}]})));
    const onDiagnostic=vi.fn();
    const result=await requestInvestigation({name:"supervisor_investigation_step",schema,instructions:"",
      context:{},model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(result).toBeNull();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"unparseable_json",validPrefixPartCount:1,validPrefixMatchesSchema:false}));
  });

  it("finds no valid prefix at any length when the JSON is genuinely fragmented across parts",async()=>{
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
      {invalidPayloadReason:"unparseable_json",outputTextPartCount:2,validPrefixPartCount:0}));
  });

  it("accepts a valid 2-part JSON prefix even when the first part alone does not parse, with trailing noise in a third part",async()=>{
    // This is the case a check of texts[0] alone would get wrong: no single
    // part parses by itself, but the first TWO parts together form a complete,
    // schema-valid answer, with a third part of trailing noise after it —
    // not genuine mid-token fragmentation, so it is accepted.
    const whole=JSON.stringify({x:"ok"});
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
        {type:"output_text",text:whole.slice(0,5)},
        {type:"output_text",text:whole.slice(5)},
        {type:"output_text",text:" trailing garbage"},
      ]}]})));
    const onDiagnostic=vi.fn();
    const result=await requestInvestigation({name:"supervisor_investigation_step",schema,instructions:"",
      context:{},model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    expect(result).toEqual({x:"ok"});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {outputTextPartCount:3,validPrefixPartCount:2,validPrefixMatchesSchema:true}));
  });

  it("reports schema_mismatch with the failing field path, issue count, AND the full shape bundle",async()=>{
    const transport=vi.fn(async()=>completed({x:""}));
    const onDiagnostic=vi.fn();
    await requestInvestigation({name:"supervisor_investigation_review",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000,onDiagnostic});
    // Confirms the same comprehensive bundle (shape + parse signals) reaches every
    // invalid-payload category, not just wrong_text_shape/unparseable_json: a
    // schema_mismatch here still carries the output/message shape and text length,
    // on top of its own schemaIssuePath/Code/Count.
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining(
      {invalidPayloadReason:"schema_mismatch",schemaIssuePath:"x",schemaIssueCode:"too_small",
        schemaIssueCount:1,outputItemTypes:["message"],messagePartTypes:["output_text"],
        outputTextPartCount:1,jsonTextLength:JSON.stringify({x:""}).length}));
  });
});

describe("strict-mode JSON Schema shape sent to the provider (production incident)",()=>{
  // Production bug: a zod `.record()` field (dynamic keys, no fixed
  // `properties`) and a zod `.optional()` field (absent from `required`)
  // both make OpenAI's structured-output strict mode reject the WHOLE
  // request with a 400 "invalid_json_schema" -- on every single call using
  // that schema, regardless of what the model would have said. This walks
  // the actual wire schema `requestInvestigation` builds and asserts the
  // two invariants strict mode requires, recursively, so a future field
  // added to any investigation schema regresses here instead of in
  // production against every real owner question.
  // A dynamic-keyed field (zod `.record()`) has no fixed `properties` at
  // all -- Zod represents it with `propertyNames`/a schema-valued
  // `additionalProperties` instead of a plain `true`/`false` -- so it can
  // never be "closed" into required/properties the way a merely-optional
  // field can. The only real fix is never sending such a field at all
  // (protocol.ts's `formulaEntrySchema.variables` is now an array, not a
  // record, for exactly this reason); this helper still asserts its
  // absence everywhere, so a new record field anywhere regresses here.
  function assertStrictModeCompatible(node:unknown,path=""):void{
    if(Array.isArray(node)){node.forEach((n,i)=>assertStrictModeCompatible(n,path+"["+i+"]"));return;}
    if(!node||typeof node!=="object")return;
    const obj=node as Record<string,unknown>;
    expect(obj.propertyNames,path+" must never use dynamic/record-style keys").toBeUndefined();
    if(obj.type==="object"&&typeof obj.additionalProperties==="object")
      expect(obj.additionalProperties,path+" additionalProperties must be a boolean, never a schema (record-style keys)").toBe(false);
    if(obj.type==="object"&&obj.properties&&typeof obj.properties==="object"){
      const propertyKeys=Object.keys(obj.properties as Record<string,unknown>);
      const required=Array.isArray(obj.required)?obj.required as string[]:[];
      expect(required.sort(),path+" every declared property must be required").toEqual([...propertyKeys].sort());
    }
    for(const [key,value] of Object.entries(obj))assertStrictModeCompatible(value,path+"."+key);
  }
  it("closes a merely-optional field into a fully-required, nullable shape",async()=>{
    const schema=z.strictObject({
      fixed:z.string(),
      // Mirrors the exact production shape that broke: a field only
      // present on some paragraphs (answerSchema's `formulas`).
      sometimes:z.array(z.string()).max(3).optional(),
    });
    const bodies:Record<string,unknown>[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      bodies.push(JSON.parse(String(init.body)));
      return completed({fixed:"ok",sometimes:null});
    });
    await requestInvestigation({name:"supervisor_investigation_step",schema,instructions:"",context:{},
      model:"gpt-6-luna",apiKey:"k",transport,
      usage:{model:"gpt-6-luna",modelCallCount:0,toolCallCount:0,inputTokens:0,outputTokens:0},
      deadline:Date.now()+90000});
    const sent=(bodies[0].text as {format:{schema:unknown}}).format.schema;
    assertStrictModeCompatible(sent);
  });
  it("sends the real production answerSchema fully closed, with no record-shaped fields anywhere",async()=>{
    const {answerSchema}=await import("./protocol");
    const bodies:Record<string,unknown>[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      bodies.push(JSON.parse(String(init.body)));
      return completed({paragraphs:[{kind:"advice",text:"ok",citations:[]}]});
    });
    await requestInvestigation({name:"supervisor_investigation_step",schema:answerSchema,instructions:"",
      context:{},model:"gpt-6-luna",apiKey:"k",transport,
      usage:{model:"gpt-6-luna",modelCallCount:0,toolCallCount:0,inputTokens:0,outputTokens:0},
      deadline:Date.now()+90000});
    const sent=(bodies[0].text as {format:{schema:unknown}}).format.schema;
    assertStrictModeCompatible(sent);
  });
});

describe("native parallel tool selection",()=>{
  it("preserves both validated function calls in one response and advertises parallel support",async()=>{
    const schema=z.strictObject({paragraphs:z.array(z.unknown())});
    const bodies:Record<string,unknown>[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({status:"completed",usage:{input_tokens:5,output_tokens:5},
        output:[{type:"function_call",name:"p3_menu_catalog_v1",call_id:"a",
            arguments:'{"id":"menu.catalog"}'},
          {type:"function_call",name:"p3_labor_employee_wages_v1",call_id:"b",
            arguments:'{"id":"labor.employee_wages"}'}]}));
    });
    const result=await requestInvestigation({name:"supervisor_investigation_step",schema,
      instructions:"",context:{},tools:[{name:"p3_menu_catalog_v1",description:"menu",parameters:{type:"object",properties:{}}},
        {name:"p3_labor_employee_wages_v1",description:"labor",parameters:{type:"object",properties:{}}}],
      model:"gpt-6-luna",apiKey:"k",transport,usage:baseUsage(),deadline:Date.now()+90000});
    expect(result).toMatchObject({type:"tool_call",callId:"a",
      calls:[{callId:"a"},{callId:"b"}]});
    expect(bodies[0].parallel_tool_calls).toBe(true);
  });
});
