import {describe,expect,it,vi} from "vitest";
import {agentToolDefinitions,executeAgentTool,type AgentToolContext} from "./index";
describe("retired model incident reader",()=>{
  it("is neither advertised nor callable; the worker collects the claimed incident itself",async()=>{
    expect(agentToolDefinitions.map(t=>t.name)).not.toContain("get_investigation_source");
    const read=vi.fn();
    const context={investigation:{read}} as unknown as AgentToolContext;
    await expect(executeAgentTool("get_investigation_source",{},context)).rejects.toMatchObject({code:"not_supported"});
    expect(read).not.toHaveBeenCalled();
  });
});
