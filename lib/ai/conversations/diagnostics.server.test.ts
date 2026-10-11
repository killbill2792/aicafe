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
  it("carries only sanitized typed provider status, stage and category",()=>{
    const error=new SupervisorStageError("provider_incomplete","provider_response",
      {httpStatus:200,providerStatus:"incomplete",round:2,attempt:1});
    expect(classifySupervisorError(error,"conversation_auth")).toMatchObject({
      stage:"provider_response",category:"provider_incomplete",httpStatus:200,
      providerStatus:"incomplete",round:2,attempt:1});
  });
});
