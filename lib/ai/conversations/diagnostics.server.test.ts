import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {createSupervisorDiagnosticLogger,classifySupervisorError,SupervisorStageError,readSafeProviderError} from "./diagnostics.server";
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
  it("carries only sanitized typed provider status, stage and category",()=>{
    const error=new SupervisorStageError("provider_incomplete","provider_response",
      {httpStatus:200,providerStatus:"incomplete",round:2,attempt:1});
    expect(classifySupervisorError(error,"conversation_auth")).toMatchObject({
      stage:"provider_response",category:"provider_incomplete",httpStatus:200,
      providerStatus:"incomplete",round:2,attempt:1});
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
