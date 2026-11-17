import {describe,expect,it,vi} from "vitest";
import {agentToolDefinitions,executeAgentTool,investigationToolDefinition,
  type AgentToolContext} from "./index";
const context=(port?:()=>Promise<unknown>)=>({
  locale:"en",asOf:"2026-11-14",timezone:"America/Los_Angeles",
  tools:{getProfitability:vi.fn(),getSalesTrend:vi.fn(),getMenuCatalog:vi.fn()},
  ...(port?{investigation:{read:port}}:{}),
} as unknown as AgentToolContext);
describe("Task 15A exact incident model tool authorization",()=>{
  it("is absent from ordinary owner conversation tool definitions",()=>{
    expect(agentToolDefinitions.map(t=>t.name)).not.toContain("get_investigation_source");
    expect(investigationToolDefinition.name).toBe("get_investigation_source");
    expect(investigationToolDefinition.parameters).toMatchObject({
      type:"object",additionalProperties:false,
    });
  });
  it("cannot be used without a database-claimed server context",async()=>{
    const result=await executeAgentTool("get_investigation_source",{},context());
    expect(result).toMatchObject({source:"investigation_source",
      missing:["investigation_not_authorized"]});
  });
  it("never accepts model-selected tenant, timecard or alert identifiers",async()=>{
    const port=vi.fn(async()=>({source:"investigation_source",
      sourceType:"alert",sourceId:"claim-bound-alert",incidentKind:"meal_break",
      period:null,missing:[]}));
    await expect(executeAgentTool("get_investigation_source",
      {business_id:"other-cafe"},context(port))).rejects.toThrow();
    await expect(executeAgentTool("get_investigation_source",
      {sourceId:"attacker-selected-alert"},context(port))).rejects.toThrow();
    expect(port).not.toHaveBeenCalled();
    const result=await executeAgentTool("get_investigation_source",{},context(port));
    expect(port).toHaveBeenCalledOnce();
    expect(result.sourceId).toBe("claim-bound-alert");
  });
});
