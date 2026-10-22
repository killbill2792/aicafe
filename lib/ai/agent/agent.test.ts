import { describe, expect, it } from "vitest";
import { checkNumbers } from "./checkNumbers";
import { statusFromResults } from "./status";
import { executeAgentTool, agentToolDefinitions } from "./tools";

const base = { source: "profitability", period: null, missing: [], labels: {},
  ownerProfitCents: 12345, operatingMargin: 0.125, coveredSalesDays: 4 };
describe("numbers, statuses, and strict tool contracts", () => {
  it("verifies cents, percentages and plain numbers without erasing text", () => {
    expect(checkNumbers("Profit $123.45, 12.5% margin, 4 days", "", [base], "en")).toEqual([]);
    expect(checkNumbers("Profit $999.00", "", [base], "en")).toHaveLength(1);
    expect(checkNumbers("Profit 123,45 €, 12,5%", "", [base], "es")).toHaveLength(1);
    expect(checkNumbers("123,45 دولار", "123,45", [base], "ar").length).toBeGreaterThanOrEqual(0);
    expect(checkNumbers("We agreed on 5", "5", [], "en")).toEqual([]);
  });
  it("uses successful retries and actual missing evidence", () => {
    expect(statusFromResults([{callId:"a", result:{...base, missing:["first"]}},
      {callId:"a",result:base}]).status).toBe("complete");
    expect(statusFromResults([{callId:"b",result:{...base,missing:["sales"]}}])).toEqual({
      status:"partial",missing:["sales"] });
  });
  it("publishes only three strict functions", () => {
    expect(agentToolDefinitions.map(t=>t.name)).toEqual(["get_profit","get_sales","get_menu_items"]);
    expect(agentToolDefinitions.every(t=>t.strict)).toBe(true);
  });
  it("reads menu without a user-provided business id", async () => {
    const tools = {getMenuCatalog: async()=>({available:true, value:[{id:"a",name:"Latte",category:"drink",active:true,priceCents:450}],quality:{missingInputs:[]}})};
    const result = await executeAgentTool("get_menu_items", {}, {tools:tools as never,asOf:"2026-10-21",locale:"en"});
    expect(result.items).toEqual([{id:"a",name:"Latte",category:"drink",priceCents:450}]);
    await expect(executeAgentTool("get_menu_items",{businessId:"other"},{tools:tools as never,asOf:"2026-10-21",locale:"en"})).rejects.toThrow();
  });
});
