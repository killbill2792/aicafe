import { describe, expect, it } from "vitest";
import { checkNumbers } from "./checkNumbers";
import { statusFromResults } from "./status";
import { executeAgentTool, agentToolDefinitions, type AgentToolContext, requestedPeriod } from "./tools";

const base = { source: "profitability", period: null, missing: [],
  ownerProfitCents: 12345, operatingMargin: 0.125, coveredSalesDays: 4 };
describe("numbers, statuses, and strict tool contracts", () => {
  it("verifies cents, percentages and plain numbers without erasing text", () => {
    expect(checkNumbers("Profit $123.45, 12.5% margin, 4 days", "", [base], "en")).toEqual([]);
    expect(checkNumbers("Profit $999.00", "", [base], "en")).toHaveLength(1);
    expect(checkNumbers("Profit 123,45 €, 12,5%", "", [base], "es")).toEqual([]);
    expect(checkNumbers("Profit 123,46 €, 12,6%", "", [base], "es")).toEqual([]);
    expect(checkNumbers("Profit 123,47 €, 12,7%", "", [base], "es")).toHaveLength(2);
    expect(checkNumbers("123,45 دولار", "", [base], "ar")).toEqual([]);
    expect(checkNumbers("١٢٣٫٤٥ د.إ", "", [base], "ar")).toEqual([]);
    expect(checkNumbers("١٢٣٫٩٩ د.إ", "", [base], "ar")).toHaveLength(1);
    expect(checkNumbers("We agreed on 5", "5", [], "en")).toEqual([]);
  });
  it("uses successful retries and actual missing evidence", () => {
    expect(statusFromResults([{callId:"a",name:"get_profit",arguments:'{"period":"month"}',result:{...base, missing:["first"]}},
      {callId:"new-retry-id",name:"get_profit",arguments:'{"period":"month"}',result:base}]).status).toBe("complete");
    expect(statusFromResults([{callId:"b",name:"get_sales",arguments:'{"period":"today"}',result:{...base,missing:["sales"]}}])).toEqual({
      status:"partial",missing:["sales"] });
  });
  it("publishes only three strict functions", () => {
    expect(agentToolDefinitions.map(t=>t.name)).toEqual(["get_profit","get_sales","get_menu_items"]);
    expect(agentToolDefinitions.every(t=>t.strict)).toBe(true);
    for (const tool of agentToolDefinitions) {
      expect(Object.hasOwn(tool.parameters,"$schema")).toBe(false);
      expect(tool.parameters).toHaveProperty("additionalProperties",false);
      expect(tool.parameters.required).toEqual(Object.keys(tool.parameters.properties ?? {}));
    }
    expect(requestedPeriod("today","2026-10-21")).toEqual({from:"2026-10-21",to:"2026-10-21"});
    expect(requestedPeriod("week","2026-10-21")).toEqual({from:"2026-10-15",to:"2026-10-21"});
    expect(requestedPeriod("month","2026-10-21")).toEqual({from:"2026-10-01",to:"2026-10-21"});
  });
  it("reads menu without a user-provided business id", async () => {
    const context: AgentToolContext = {
      asOf: "2026-10-21", locale: "en",
      tools: {
        getMenuCatalog: async () => ({available:true, value:[
          {id:"a",name:"Latte",category:"drink",active:true,priceCents:450},
          {id:"b",name:"Cappuccino",category:"drink",active:true,priceCents:550},
        ],quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
        getProfitability: async () => ({available:false,value:null,quality:{
          level:"low",missingInputs:["profit"],estimatedInputs:[],staleInputs:[]}}),
        getSalesTrend: async () => ({available:false,value:null,quality:{
          level:"low",missingInputs:["sales"],estimatedInputs:[],staleInputs:[]}}),
      },
    };
    const result = await executeAgentTool("get_menu_items",{query:"latte",limit:25},context);
    expect(result.items).toEqual([{id:"a",name:"Latte",category:"drink",priceCents:450}]);
    await expect(executeAgentTool("get_menu_items",{businessId:"other"},context)).rejects.toThrow();
    await expect(executeAgentTool("get_menu_items",{query:null,limit:26},context)).rejects.toThrow();
  });
});
