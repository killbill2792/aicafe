import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {createSupervisorDiagnosticLogger,classifySupervisorError,SupervisorStageError,readSafeProviderError,logSupervisorDebugPayload} from "./diagnostics.server";
import {SupervisorReplyValidationError} from "./replyValidation";
import {withSupervisorPrivateTrace,isSupervisorPrivateTraceTester} from "./privateTrace.server";
import {gunzipSync} from "node:zlib";
describe("Sanitized Supervisor production diagnostics",()=>{
  it("includes a stable request correlation ID with safe stage/counters only",()=>{
    const written:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>written.push(line));
    logger.emit({stage:"provider_request",model:"gpt-6-luna",advertisedToolCount:10,
      advertisedToolNames:["get_financials","conversation_control"],
      modelCallCount:2,toolCallCount:1});
    logger.emit({stage:"provider_response",category:"provider_http",httpStatus:400,
      round:1,attempt:1,providerStatus:"failed"});
    const rows=written.map(value=>JSON.parse(value));
    expect(rows[0].requestId).toBe(rows[1].requestId);
    expect(rows[0].advertisedToolNames).toEqual(["get_financials","conversation_control"]);
    expect(rows[1]).toMatchObject({category:"provider_http",httpStatus:400});
  });
  it("does not print raw error messages, prompts, response payloads or secrets",()=>{
    const lines:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>lines.push(line));
    const confidential="highly confidential employee money prompt key";
    const error=new Error(confidential);
    logger.emit({...classifySupervisorError(error,"tool_execution"),
      advertisedToolNames:["private tool detail\u2028","get_staff"],model:"gpt-6-luna"});
    const output=lines.join(" ");
    expect(output).not.toContain(confidential);
    expect(output).not.toContain("private tool detail");
    expect(output).toContain('"category":"unexpected"');
  });
  it("reads only bounded error.type/error.code and optional request ID",async()=>{
    const response=new Response(JSON.stringify({error:{
      type:"restricted_organization",code:"feature_blocked",
      message:"PRIVATE customer prompt + authorization token",unsafe:{financial:999},
    },arbitraryField:"PRIVATE arbitrary body field"}),{
      status:403,headers:{"x-request-id":"req_123.ABC-def"},
    });
    const details=await readSafeProviderError(response);
    expect(details).toEqual({
      providerErrorType:"restricted_organization",
      providerErrorCode:"feature_blocked",
      providerRequestId:"req_123.ABC-def",
    });
    expect(JSON.stringify(details)).not.toContain("message");
    expect(JSON.stringify(details)).not.toContain("arbitraryField");
    expect(JSON.stringify(details)).not.toContain("financial");
    expect(JSON.stringify(details)).not.toContain("PRIVATE");
  });
  it("rejects unsafe provider identifiers and bounds long identifiers",async()=>{
    const loggerLines:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>loggerLines.push(line));
    const invalid=new Response(JSON.stringify({error:{
      type:"unauthorized because secret",code:{unexpected:"private"},
      message:"NEVER_EMIT_ME",
    }}),{status:403,headers:{"x-request-id":"unsafe header value"}});
    const parsed=await readSafeProviderError(invalid);
    expect(parsed).toEqual({providerErrorType:undefined,providerErrorCode:undefined,providerRequestId:undefined});
    logger.emit({stage:"provider_response",category:"provider_http",
      providerErrorType:"BAD whitespace secret",providerErrorCode:"feature_blocked",
      providerRequestId:"req".repeat(100)});
    const logged=JSON.parse(loggerLines[0]);
    expect(logged.providerErrorType).toBeUndefined();
    expect(logged.providerErrorCode).toBe("feature_blocked");
    expect(logged.providerRequestId).toHaveLength(64);
    expect(JSON.stringify(logged)).not.toContain("NEVER_EMIT_ME");
  });
  it("leaves malformed/non-JSON error bodies uninspected in diagnostics",async()=>{
    const invalid=new Response("<html>private provider error</html>",{
      status:403,headers:{"x-request-id":"req_valid-1"},
    });
    expect(await readSafeProviderError(invalid)).toEqual({
      providerErrorType:undefined,providerErrorCode:undefined,providerRequestId:"req_valid-1",
    });
  });
  it("sanitizes fallback transition models and access trigger identifiers",()=>{
    const written:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>written.push(line));
    logger.emit({stage:"provider_fallback",fromModel:"gpt-6-luna",toModel:"gpt-4.1-mini",
      triggerHttpStatus:403,triggerProviderErrorType:"permission_error",
      triggerProviderErrorCode:"model_not_available"});
    logger.emit({stage:"provider_fallback",fromModel:"model\\nPRIVATE",toModel:"mini",
      triggerHttpStatus:403,triggerProviderErrorType:"PRIVATE text and tokens",
      triggerProviderErrorCode:"PRIVATE raw error.message"});
    const first=JSON.parse(written[0]),second=JSON.parse(written[1]);
    expect(first).toMatchObject({stage:"provider_fallback",fromModel:"gpt-6-luna",
      toModel:"gpt-4.1-mini",triggerHttpStatus:403,
      triggerProviderErrorType:"permission_error",
      triggerProviderErrorCode:"model_not_available"});
    expect(second.fromModel).toBeUndefined();
    expect(second.triggerProviderErrorType).toBeUndefined();
    expect(second.triggerProviderErrorCode).toBeUndefined();
    expect(written.join(" ")).not.toContain("raw error.message");
  });
  it("logs deduped, bounded output/message type tags and a safe text-part count",()=>{
    const lines:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>lines.push(line));
    logger.emit({stage:"provider_response",category:"provider_invalid_payload",
      invalidPayloadReason:"wrong_text_shape",requestName:"supervisor_investigation_step",
      outputItemTypes:["message","message","reasoning","PRIVATE owner text "],
      messagePartTypes:["refusal"],outputTextPartCount:0});
    const logged=JSON.parse(lines[0]);
    expect(logged.outputItemTypes).toEqual(["message","reasoning"]);
    expect(logged.messagePartTypes).toEqual(["refusal"]);
    expect(logged.outputTextPartCount).toBe(0);
    expect(JSON.stringify(logged)).not.toContain("PRIVATE");
  });
  it("omits output/message type tags entirely when none are safe or present",()=>{
    const lines:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>lines.push(line));
    logger.emit({stage:"provider_response",category:"provider_invalid_payload",
      outputItemTypes:["PRIVATE only unsafe tag"],messagePartTypes:[],outputTextPartCount:-1});
    const logged=JSON.parse(lines[0]);
    expect(logged.outputItemTypes).toBeUndefined();
    expect(logged.messagePartTypes).toBeUndefined();
    expect(logged.outputTextPartCount).toBeUndefined();
  });
  it("drops an identifier-shaped value that is not an actual documented type, even on the untrusted malformed-payload path",()=>{
    const lines:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>lines.push(line));
    // sk-abc123_secret-token is syntactically identifier-shaped (matches [a-zA-Z0-9_.-]+)
    // but is not one of OpenAI's documented output-item/content-part type values.
    const error=new SupervisorStageError("provider_invalid_payload","provider_response",
      {invalidPayloadReason:"wrong_text_shape",
        outputItemTypes:["message","sk-abc123_secret-token"],
        messagePartTypes:["output_text","sk-abc123_secret-token"]});
    logger.emit({...classifySupervisorError(error,"provider_response")});
    const logged=JSON.parse(lines[0]);
    expect(logged.outputItemTypes).toEqual(["message"]);
    expect(logged.messagePartTypes).toEqual(["output_text"]);
    expect(JSON.stringify(logged)).not.toContain("sk-abc123_secret-token");
  });
  it("carries a safe answerRejectedReason but drops an unrecognized one",()=>{
    const lines:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>lines.push(line));
    logger.emit({stage:"investigation_round",agent:"supervisor",modelCallCount:5,toolCallCount:3,
      answerRejectedReason:"render_failed"});
    logger.emit({stage:"investigation_round",agent:"supervisor",modelCallCount:6,toolCallCount:3,
      answerRejectedReason:"review_unavailable"});
    logger.emit({stage:"investigation_round",agent:"supervisor",modelCallCount:7,toolCallCount:3,
      answerRejectedReason:"PRIVATE not a real reason" as never});
    const [first,second,third]=lines.map(line=>JSON.parse(line));
    expect(first.answerRejectedReason).toBe("render_failed");
    expect(second.answerRejectedReason).toBe("review_unavailable");
    expect(third.answerRejectedReason).toBeUndefined();
    expect(JSON.stringify(third)).not.toContain("PRIVATE");
  });
  it("carries a typed rescuedUnverified boolean on investigation_exhausted",()=>{
    const lines:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>lines.push(line));
    logger.emit({stage:"investigation_exhausted",exhaustionReason:"model_calls",
      modelCallCount:7,toolCallCount:4,rescuedUnverified:true});
    logger.emit({stage:"investigation_exhausted",exhaustionReason:"model_calls",
      modelCallCount:7,toolCallCount:0,rescuedUnverified:false});
    const [first,second]=lines.map(line=>JSON.parse(line));
    expect(first.rescuedUnverified).toBe(true);
    expect(second.rescuedUnverified).toBe(false);
  });
  it("carries only sanitized typed provider status, stage and category",()=>{
    const error=new SupervisorStageError("provider_incomplete","provider_response",
      {httpStatus:200,providerStatus:"incomplete",round:2,attempt:1});
    expect(classifySupervisorError(error,"conversation_auth")).toMatchObject({
      stage:"provider_response",category:"provider_incomplete",httpStatus:200,
      providerStatus:"incomplete",round:2,attempt:1});
  });
  it("classifies a SupervisorReplyValidationError under its own reply_validation stage/category, carrying only the safe reason", () => {
    const reply={intent:"profitability" as const,status:"verified" as const,evidence:[],
      blocks:[{type:"text" as const,text:"PRIVATE café figure that must never reach the log"}]};
    const error=new SupervisorReplyValidationError("missing_evidence",
      "Supervisor response requires trusted evidence",reply);
    const classified=classifySupervisorError(error,"reply_persistence");
    expect(classified).toEqual({stage:"reply_validation",category:"reply_validation",
      replyValidationReason:"missing_evidence"});
    const lines:string[]=[];
    createSupervisorDiagnosticLogger(line=>lines.push(line)).emit({...classified,model:"gpt-6-luna"});
    const logged=JSON.parse(lines[0]);
    expect(logged).toMatchObject({stage:"reply_validation",category:"reply_validation",
      replyValidationReason:"missing_evidence"});
    expect(JSON.stringify(logged)).not.toContain("PRIVATE");
  });
  it("drops an unrecognized replyValidationReason from the sanitized log",()=>{
    const lines:string[]=[];
    createSupervisorDiagnosticLogger(line=>lines.push(line)).emit({
      stage:"reply_validation",category:"reply_validation",
      replyValidationReason:"PRIVATE not a real reason" as never});
    const logged=JSON.parse(lines[0]);
    expect(logged.replyValidationReason).toBeUndefined();
    expect(JSON.stringify(logged)).not.toContain("PRIVATE");
  });
});

describe("Scope reconciliation telemetry never logs utterances or task contents",()=>{
  it("logs only enumerated goal families, typed booleans and a safe outcome",()=>{
    const lines:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>lines.push(line));
    logger.emit({stage:"scope_reconciliation",
      declaredGoalDomains:["team","not_a_domain OWNER SECRET" as never],
      auditedGoalDomains:["staff_coverage","PRIvATE task text" as never],
      normalizedGoalDomains:["team","staff_coverage","overview"],
      scopeAuditComplete:true,scopeAuditAmbiguous:false,reconciliationOutcome:"semantic_conflict",
      // Runtime injection must not be reflected as arbitrary diagnostic properties.
      ownerText:"What task needs my attention?"} as never);
    const result=JSON.parse(lines[0]);
    expect(result).toMatchObject({stage:"scope_reconciliation",
      declaredGoalDomains:["team"],auditedGoalDomains:["staff_coverage"],
      normalizedGoalDomains:["team","staff_coverage","overview"],
      scopeAuditComplete:true,scopeAuditAmbiguous:false,reconciliationOutcome:"semantic_conflict"});
    expect(JSON.stringify(result)).not.toMatch(/OWNER SECRET|PRIvATE|What task|ownerText/);
  });
  it("drops non-enumerated outcomes and never prints arbitrary café payload",()=>{
    const lines:string[]=[];
    createSupervisorDiagnosticLogger(x=>lines.push(x)).emit({
      stage:"scope_reconciliation",declaredGoalDomains:["team"],
      auditedGoalDomains:[],normalizedGoalDomains:["team"],
      reconciliationOutcome:"PRIVATE Task Latte instructions" as never,
      scopeAuditComplete:false,scopeAuditAmbiguous:false,
      taskTitle:"secret task title",business_id:"sensitive-id"} as never);
    const d=JSON.parse(lines[0]);
    expect(d.reconciliationOutcome).toBeUndefined();
    expect(JSON.stringify(d)).not.toMatch(/PRIVATE|Latte|secret|sensitive-id|business_id/);
  });
});

describe("TEMPORARY test-only debug capture (logSupervisorDebugPayload)",()=>{
  const previousFlag=process.env.SUPERVISOR_DEBUG_RAW_LOGGING;
  afterEach(()=>{
    if(previousFlag===undefined)delete process.env.SUPERVISOR_DEBUG_RAW_LOGGING;
    else process.env.SUPERVISOR_DEBUG_RAW_LOGGING=previousFlag;
  });
  it("stays silent unless SUPERVISOR_DEBUG_RAW_LOGGING is exactly \"true\"",()=>{
    const lines:string[]=[];
    delete process.env.SUPERVISOR_DEBUG_RAW_LOGGING;
    logSupervisorDebugPayload({ownerQuestion:"What did Sophie earn this week?"},(l)=>lines.push(l));
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="TRUE";
    logSupervisorDebugPayload({ownerQuestion:"What did Sophie earn this week?"},(l)=>lines.push(l));
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="false";
    logSupervisorDebugPayload({ownerQuestion:"What did Sophie earn this week?"},(l)=>lines.push(l));
    expect(lines).toHaveLength(0);
  });
  it("logs the raw, unsanitized payload verbatim once explicitly enabled",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"direct_answer_attempt",ownerQuestion:"What did Sophie earn this week?",
      rawAnswerParagraphs:[{kind:"evidence",text:"Sophie earned {{r1:value.wageCents}}.",citations:["r1"]}]},
      (l)=>lines.push(l));
    expect(lines).toHaveLength(1);
    const logged=JSON.parse(lines[0]);
    expect(logged.event).toBe("supervisor_turn_debug_test_only");
    expect(logged.ownerQuestion).toBe("What did Sophie earn this week?");
    expect(logged.rawAnswerParagraphs[0].text).toContain("Sophie earned");
  });
  it("logs a per-round capability_round point with the capability and its result status",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"capability_round",requestId:"abc123",round:2,
      capabilityId:"p3.menu.catalog.v1",status:"verified"},(l)=>lines.push(l));
    const logged=JSON.parse(lines[0]);
    expect(logged).toMatchObject({point:"capability_round",requestId:"abc123",round:2,
      capabilityId:"p3.menu.catalog.v1",status:"verified"});
  });
  it("logs a per-round retry_feedback point carrying the exact feedback text given to that round",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"retry_feedback",requestId:"abc123",round:3,
      feedback:"Paragraph 1: the number \"$2\" has no citation..."},(l)=>lines.push(l));
    const logged=JSON.parse(lines[0]);
    expect(logged.point).toBe("retry_feedback");
    expect(logged.feedback).toContain("Paragraph 1");
  });
  it("logs a per-round claim_issues_retry point with which gate rejected which claim and why",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"claim_issues_retry",requestId:"abc123",round:3,
      issues:[{kind:"unmatched_number",paragraphIndex:0,text:"$2",matchedObservation:null}]},(l)=>lines.push(l));
    const logged=JSON.parse(lines[0]);
    expect(logged.point).toBe("claim_issues_retry");
    expect(logged.issues[0]).toMatchObject({kind:"unmatched_number",text:"$2"});
  });
  it("logs a per-round review_verdict point distinct from the final exhaustion summary, with the reviewer's own reason",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"review_verdict",requestId:"abc123",round:4,
      supported:true,complete:false,reason:"Monthly staffing goal from the owner's request is still unaddressed."},
      (l)=>lines.push(l));
    const logged=JSON.parse(lines[0]);
    expect(logged).toMatchObject({point:"review_verdict",round:4,supported:true,complete:false,
      reason:"Monthly staffing goal from the owner's request is still unaddressed."});
  });
  it("logs a rescue_review_verdict point for the render-failed last-resort review, with its own reason",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"rescue_review_verdict",requestId:"abc123",round:5,
      supported:false,complete:true,reason:"Claim of a completed action has no supporting observation."},
      (l)=>lines.push(l));
    const logged=JSON.parse(lines[0]);
    expect(logged).toMatchObject({point:"rescue_review_verdict",round:5,supported:false,complete:true,
      reason:"Claim of a completed action has no supporting observation."});
  });
  it("logs an accumulated_rescue_review_verdict point for the §7 best-candidate review, with its own reason",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"accumulated_rescue_review_verdict",requestId:"abc123",
      supported:true,complete:true,reason:"Every surviving block is backed by a real citation."},
      (l)=>lines.push(l));
    const logged=JSON.parse(lines[0]);
    expect(logged).toMatchObject({point:"accumulated_rescue_review_verdict",supported:true,complete:true,
      reason:"Every surviving block is backed by a real citation."});
  });
  it("shares one requestId across every round's debug point for the same turn",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"capability_round",requestId:"same-turn-id",round:1},(l)=>lines.push(l));
    logSupervisorDebugPayload({point:"direct_answer_attempt",requestId:"same-turn-id",round:2},(l)=>lines.push(l));
    logSupervisorDebugPayload({point:"investigation_exhausted",requestId:"same-turn-id"},(l)=>lines.push(l));
    const requestIds=lines.map(l=>JSON.parse(l).requestId);
    expect(new Set(requestIds).size).toBe(1);
  });
  it("logs a turn_received point with the raw owner message and thread id, before the investigation loop runs",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"turn_received",requestId:"turn-id",
      threadId:"thread-1",ownerQuestion:"What did Sophie earn this week?"},(l)=>lines.push(l));
    const logged=JSON.parse(lines[0]);
    expect(logged).toMatchObject({point:"turn_received",requestId:"turn-id",
      threadId:"thread-1",ownerQuestion:"What did Sophie earn this week?"});
  });
  it("logs a reply_validation_failed point with which check failed and the full reply shape that tripped it",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"reply_validation_failed",requestId:"turn-id",
      reason:"missing_evidence",
      reply:{intent:"profitability",status:"verified",evidence:[],
        blocks:[{type:"text",text:"Unverified financial claim"}]}},(l)=>lines.push(l));
    const logged=JSON.parse(lines[0]);
    expect(logged.point).toBe("reply_validation_failed");
    expect(logged.reason).toBe("missing_evidence");
    expect(logged.reply.blocks[0].text).toBe("Unverified financial claim");
  });
  it("logs a persistence_result point distinguishing the real attempt from a fallback retry",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"persistence_result",requestId:"turn-id",ok:false},(l)=>lines.push(l));
    logSupervisorDebugPayload({point:"persistence_result",requestId:"turn-id",ok:true,fallback:true},(l)=>lines.push(l));
    const [first,second]=lines.map(l=>JSON.parse(l));
    expect(first).toMatchObject({point:"persistence_result",ok:false});
    expect(second).toMatchObject({point:"persistence_result",ok:true,fallback:true});
  });
  it("logs an http_response_sent point with the actual reply shape/status returned to the owner",()=>{
    const lines:string[]=[];
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    logSupervisorDebugPayload({point:"http_response_sent",requestId:"turn-id",
      httpStatus:201,replyStatus:"insufficient_evidence"},(l)=>lines.push(l));
    const logged=JSON.parse(lines[0]);
    expect(logged).toMatchObject({point:"http_response_sent",httpStatus:201,
      replyStatus:"insufficient_evidence"});
  });
});

describe("cost ledger and single-user pilot access",()=>{
  it("requires an exact, explicitly configured UUID to activate pilot capture",()=>{
    vi.stubEnv("SUPERVISOR_PRIVATE_TRACE_ENABLED","true");
    vi.stubEnv("SUPERVISOR_PRIVATE_TRACE_TEST_USER_ID","11111111-1111-4111-8111-111111111111");
    try{
      expect(isSupervisorPrivateTraceTester("11111111-1111-4111-8111-111111111111")).toBe(true);
      expect(isSupervisorPrivateTraceTester("22222222-2222-4222-8222-222222222222")).toBe(false);
      vi.stubEnv("SUPERVISOR_PRIVATE_TRACE_TEST_USER_ID","");
      expect(isSupervisorPrivateTraceTester("11111111-1111-4111-8111-111111111111")).toBe(false);
    }finally{vi.unstubAllEnvs();}
  });
  it("provides a per-turn cached-aware token and cost ledger",async()=>{
    vi.stubEnv("SUPERVISOR_PRIVATE_TRACE_ENABLED","true");
    try{
      let recorded:{events:Record<string,unknown>[];droppedCount:number}|null=null;
      await withSupervisorPrivateTrace(async()=>{
        logSupervisorDebugPayload({point:"model_request",requestName:"supervisor_investigation_step",
          modelCallCount:1,body:{name:"test"}});
        logSupervisorDebugPayload({point:"model_usage",model:"gpt-6-luna",
          requestName:"supervisor_investigation_step",
          usage:{inputTokens:10000,cachedInputTokens:6000,uncachedInputTokens:4000,
            outputTokens:2000,reasoningOutputTokens:1200},estimatedCostMicros:1460});
      },async result=>{recorded=result;});
      const totals=recorded!.events.at(-1)!;
      expect(totals.point).toBe("trace_summary");
      expect(totals.expectedModelRequests).toBe(1);
      expect(totals.inputTokens).toBe(10000);
      expect(totals.cachedInputTokens).toBe(6000);
      expect(totals.reasoningOutputTokens).toBe(1200);
      expect(totals.estimatedCostMicros).toBe(1460);
      expect(totals.captureComplete).toBe(true);
      expect(recorded!.droppedCount).toBe(0);
    }finally{vi.unstubAllEnvs();}
  });
  it("does not present an unpriced attempted call as a zero-dollar bill",async()=>{
    vi.stubEnv("SUPERVISOR_PRIVATE_TRACE_ENABLED","true");
    try{
      let recorded:{events:Record<string,unknown>[]}|null=null;
      await withSupervisorPrivateTrace(async()=>{
        logSupervisorDebugPayload({point:"model_request",requestName:"step",body:{model:"unknown"}});
      },async result=>{recorded=result;});
      const totals=recorded!.events.at(-1)!;
      expect(totals.estimatedCostMicros).toBeNull();
      expect(totals.missingUsageResponses).toBe(1);
      expect(totals.captureComplete).toBe(false);
    }finally{vi.unstubAllEnvs();}
  });
});

describe("owner-to-R1-to-model-to-delivery trace reconstruction",()=>{
  it("records exact R1 source values, exact model preview, selected formula and delivered response",async()=>{
    vi.stubEnv("SUPERVISOR_PRIVATE_TRACE_ENABLED","true");
    try{
      let trace:{events:Record<string,unknown>[];droppedCount:number}|null=null;
      await withSupervisorPrivateTrace(async()=>{
        logSupervisorDebugPayload({point:"turn_received",ownerQuestion:"What is my recurring cost?"});
        logSupervisorDebugPayload({point:"tool_result",observationId:"r1",
          capabilityId:"p3.money.monthly_bills.v1",
          toolArguments:{id:"money.monthly_bills"},
          result:{status:"verified",value:{totalCents:746700},unit:"typed_record"}});
        logSupervisorDebugPayload({point:"model_request",requestName:"supervisor_investigation_step",
          body:{input:[{role:"user",content:JSON.stringify({
            observations:[{id:"r1",result:{value:{totalCents:746700}}}],
            authorizedOperands:[{handle:"money.monthly_bills:value:totalCents",unit:"USD_cents"}]})}]}});
        logSupervisorDebugPayload({point:"model_response",raw:{
          usage:{input_tokens:120,output_tokens:40},
          output:[{type:"function_call",name:"calculate",arguments:JSON.stringify({
            nodes:[{op:"source",handle:"money.monthly_bills:value:totalCents"}]})}]}});
        logSupervisorDebugPayload({point:"http_response_sent",httpStatus:201,
          responseBody:{reply:{status:"verified",blocks:[{type:"text",text:"$7,467.00"}]}}});
      },async t=>{trace=t;});
      expect(trace!.droppedCount).toBe(0);
      expect(trace!.events.map(e=>e.point)).toEqual([
        "turn_received","tool_result","model_request","model_response","http_response_sent","trace_summary"]);
      expect((trace!.events[1].result as {value:{totalCents:number}}).value.totalCents).toBe(746700);
      expect(JSON.stringify(trace!.events[2])).toContain("money.monthly_bills:value:totalCents");
      expect(JSON.stringify(trace!.events[3])).toContain("input_tokens");
      expect(JSON.stringify(trace!.events[4])).toContain("$7,467.00");
    }finally{vi.unstubAllEnvs();}
  });
  it("redacts pasted bank-statement lines while retaining non-bank amounts",async()=>{
    vi.stubEnv("SUPERVISOR_PRIVATE_TRACE_ENABLED","true");
    try{
      let trace:{events:Record<string,unknown>[]}|null=null;
      await withSupervisorPrivateTrace(async()=>{
        logSupervisorDebugPayload({point:"turn_received",
          ownerQuestion:"Review this: 10/19 ACME -$45.00\nMy rent is $700."});
      },async t=>{trace=t;});
      const logged=JSON.stringify(trace);
      expect(logged).not.toContain("10/19 ACME -$45.00");
      expect(logged).toContain("[bank_line_removed]");
      expect(logged).toContain("$700");
    }finally{vi.unstubAllEnvs();}
  });
});

describe("authenticated private trace buffer",()=>{
  it("preserves large model inputs via compressed private events without dropping them",async()=>{
    vi.stubEnv("SUPERVISOR_PRIVATE_TRACE_ENABLED","true");
    try{
      let payload:{events:Record<string,unknown>[];droppedCount:number}|null=null;
      await withSupervisorPrivateTrace(async()=>{
        logSupervisorDebugPayload({point:"model_request",requestName:"supervisor_investigation_step",
          body:{input:"a".repeat(90000),apiKey:"do-not-store"}});
      },async trace=>{payload=trace;});
      expect(payload!.droppedCount).toBe(0);
      expect(payload!.events).toHaveLength(2);
      const item=payload!.events[0];
      expect(item.encoding).toBe("gzip-base64");
      const raw=JSON.parse(gunzipSync(Buffer.from(item.data as string,"base64")).toString("utf8"));
      expect(raw.body.input).toHaveLength(90000);
      expect(raw.body.apiKey).toBe("[credential_removed]");
    }finally{vi.unstubAllEnvs();}
  });
  it("redacts secrets pasted into owner text and retains deep arrays without silent loss",async()=>{
    vi.stubEnv("SUPERVISOR_PRIVATE_TRACE_ENABLED","true");
    try{
      let payload:{events:Record<string,unknown>[];droppedCount:number}|null=null;
      await withSupervisorPrivateTrace(async()=>{
        logSupervisorDebugPayload({point:"turn_received",
          ownerQuestion:"my access token is VERYSECRET0123456789 and key sk-proj-abcdefghi1234567\nAuthorization: Basic dXNlcjpwYXNz\nCookie: session=my-cookie-session\nmy API token is MYAPITOKENVALUE\\n{\"password\":\"JSON_PASSWORD_SENSITIVE\",\"clientSecret\":\"JSON_CLIENT_SECRET\"}",
          parameters:{rows:Array.from({length:180},(_,i)=>({item:i}))}});
      },async trace=>{payload=trace;});
      const serialized=JSON.stringify(payload);
      expect(serialized).not.toContain("VERYSECRET0123456789");
      expect(serialized).not.toContain("sk-proj-abcdefghi1234567");
      expect(serialized).not.toContain("dXNlcjpwYXNz");
      expect(serialized).not.toContain("my-cookie-session");
      expect(serialized).not.toContain("MYAPITOKENVALUE");
      expect(serialized).not.toContain("JSON_PASSWORD_SENSITIVE");
      expect(serialized).not.toContain("JSON_CLIENT_SECRET");
      expect(payload!.droppedCount).toBe(0);
      expect((payload!.events[0].parameters as {rows:unknown[]}).rows).toHaveLength(180);
    }finally{vi.unstubAllEnvs();}
  });
  it("keeps exact diagnostic parameters but strips credential properties",async()=>{
    vi.stubEnv("SUPERVISOR_PRIVATE_TRACE_ENABLED","true");
    vi.stubEnv("SUPERVISOR_DEBUG_RAW_LOGGING","false");
    try{
      let collected:{events:Record<string,unknown>[];droppedCount:number}|null=null;
      await withSupervisorPrivateTrace(async()=>{
        logSupervisorDebugPayload({point:"calculator_rejected",reasonCode:"unknown_operand",
          toolArguments:{nodes:[{op:"source",handle:"unknown"}]},
          ownerQuestion:"What are my wages?",authorization:"Bearer sensitive"});
      },async trace=>{collected=trace;});
      expect(collected).not.toBeNull();
      const content=JSON.stringify(collected);
      expect(content).toContain("unknown_operand");
      expect(content).toContain("What are my wages?");
      expect(content).not.toContain("Bearer sensitive");
      expect(collected!.events).toHaveLength(2);
    }finally{vi.unstubAllEnvs();}
  });
});

describe("test-only raw investigation trace security boundary",()=>{
  it("emits allowlisted metadata, never raw staff or tool data, in production",()=>{
    const lines:string[]=[];
    vi.stubEnv("NODE_ENV","production");
    vi.stubEnv("SUPERVISOR_DEBUG_RAW_LOGGING","true");
    try{
      logSupervisorDebugPayload({point:"tool_result",requestId:"safe123",round:1,
        callId:"a1",capabilityId:"p3.money.monthly_bills.v1",
        toolArguments:{secret:"bank-access-token",employee:"Sophie"},
        result:{value:{employee:"Sophie",wageCents:2500}},
        rawAnswerParagraphs:["private café fact"]},line=>lines.push(line));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({event:"supervisor_turn_debug_metadata",
        point:"tool_result",requestId:"safe123",round:1,callId:"a1",
        capabilityId:"p3.money.monthly_bills.v1"});
      expect(lines[0]).not.toMatch(/bank-access-token|Sophie|2500|private café fact/);
      expect(JSON.parse(lines[0])).not.toHaveProperty("result");
      expect(JSON.parse(lines[0])).not.toHaveProperty("toolArguments");
    }finally{vi.unstubAllEnvs();}
  });
});
