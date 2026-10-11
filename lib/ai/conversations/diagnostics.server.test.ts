import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {createSupervisorDiagnosticLogger,classifySupervisorError,SupervisorStageError} from "./diagnostics.server";
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
  it("carries only sanitized typed provider status, stage and category",()=>{
    const error=new SupervisorStageError("provider_incomplete","provider_response",
      {httpStatus:200,providerStatus:"incomplete",round:2,attempt:1});
    expect(classifySupervisorError(error,"conversation_auth")).toMatchObject({
      stage:"provider_response",category:"provider_incomplete",httpStatus:200,
      providerStatus:"incomplete",round:2,attempt:1});
  });
});
