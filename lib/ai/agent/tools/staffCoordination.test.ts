import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {executeAgentTool,agentToolDefinitions,type AgentToolContext} from "./index";
describe("retired staff-coordination reader",()=>{
 it("rejects the old reader even when an owner-scoped port is present",async()=>{
  const read=vi.fn();
  const context={staffCoordinationRead:read} as unknown as AgentToolContext;
  expect(agentToolDefinitions.map(t=>t.name)).not.toContain("get_staff_coordination_cases");
  await expect(executeAgentTool("get_staff_coordination_cases",{},context)).rejects.toMatchObject({code:"not_supported"});
  await expect(executeAgentTool("get_staff_coordination_cases",{business_id:"foreign-tenant"},context)).rejects.toMatchObject({code:"not_supported"});
  expect(read).not.toHaveBeenCalled();
 });
});
