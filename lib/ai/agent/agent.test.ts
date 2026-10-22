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
  it("preserves a minus sign before currency prefixes and rejects sign-reversed profit", () => {
    const positive = { source:"profitability",period:null,missing:[],ownerProfitCents:12345 };
    const negative = { source:"profitability",period:null,missing:[],ownerProfitCents:-12345 };
    const text = "Profit -$123.45";
    expect(checkNumbers(text,"",[positive],"en")).toEqual([
      { text:"-$123.45",start:7,end:15,kind:"money" },
    ]);
    expect(checkNumbers(text,"",[negative],"en")).toEqual([]);
    expect(checkNumbers("Profit $-123.45","",[positive],"en").map(v=>v.text)).toEqual(["$-123.45"]);
    expect(checkNumbers("Profit $-123.45","",[negative],"en")).toEqual([]);
    expect(checkNumbers("Profit - $123.45","",[positive],"en").map(v=>v.text)).toEqual(["- $123.45"]);
    expect(checkNumbers("Profit - $123.45","",[negative],"en")).toEqual([]);
    const negativeEuro = {source:"profitability",period:null,missing:[],ownerProfitCents:-1200};
    expect(checkNumbers("Loss −€12","",[negativeEuro],"en")).toEqual([]);
    expect(checkNumbers("Loss −€12","",[positive],"en").map(v=>v.text)).toEqual(["−€12"]);
    expect(checkNumbers("Profit +$123.45","",[positive],"en")).toEqual([]);
  });
  it("treats Arabic comma as grouping and Arabic dot as decimal before locale rules", () => {
    const evidence = [{source:"profitability",period:null,missing:[],priceCents:123400}];
    expect(checkNumbers("١٬٢٣٤ دولار", "", evidence, "ar")).toEqual([]);
    expect(checkNumbers("١٬٢٣٤ دولار", "", [
      {source:"profitability",period:null,missing:[],priceCents:123},
    ], "ar").map(n=>n.text)).toEqual(["١٬٢٣٤ دولار"]);
    expect(checkNumbers("١٬٢٣٤٫٥٠ دولار", "", [
      {source:"profitability",period:null,missing:[],priceCents:123450},
    ], "ar")).toEqual([]);
    expect(checkNumbers("١٬٢٣٤٫٥٠ دولار", "", evidence, "ar")).toHaveLength(1);
  });
  it("uses whole-percent tolerance without allowing misleading decimal percents", () => {
    expect(checkNumbers("13% margin", "", [base], "en")).toEqual([]); // 12.5% rounded to a whole percent
    expect(checkNumbers("13.1% margin", "", [base], "en")).toHaveLength(1);
    expect(checkNumbers("12.6% margin", "", [base], "en")).toEqual([]);
  });
  it("ignores year and month/day dates while still checking ordinary quantities", () => {
    const text = "October 21, 2026: 9 orders; 22 de octubre and ٢١ أكتوبر.";
    const flagged = checkNumbers(text, "", [], "es");
    expect(flagged.map(number => number.text)).toEqual(["9"]);
    expect(checkNumbers("2026-10-21", "", [], "en")).toEqual([]);
    expect(checkNumbers("21 October", "", [], "en")).toEqual([]);
    expect(checkNumbers("عام ٢٠٢٦ and ٢١ أكتوبر", "", [], "ar")).toEqual([]);
  });
  it("checks unqualified year-sized quantities while exempting calendar contexts", () => {
    expect(checkNumbers("We sold 2026 coffees", "", [], "en").map(n => n.text)).toEqual(["2026"]);
    expect(checkNumbers("We sold ٢٠٢٦ coffees", "", [], "ar").map(n => n.text)).toEqual(["٢٠٢٦"]);
    expect(checkNumbers("in 2026", "", [], "en")).toEqual([]);
    expect(checkNumbers("October 21, 2026", "", [], "en")).toEqual([]);
    expect(checkNumbers("October 2026", "", [], "en")).toEqual([]);
    expect(checkNumbers("Q3 2026", "", [], "en")).toEqual([]);
    expect(checkNumbers("FY 2026", "", [], "en")).toEqual([]);
    expect(checkNumbers("del 2026", "", [], "es")).toEqual([]);
    expect(checkNumbers("año 2026", "", [], "es")).toEqual([]);
    expect(checkNumbers("عام ٢٠٢٦", "", [], "ar")).toEqual([]);
    expect(checkNumbers("2026/10/21", "", [], "en")).toEqual([]);
    expect(checkNumbers("2026 coffees", "2026", [], "en")).toEqual([]);
  });
  it("does not silently join ASCII space-separated numbers", () => {
    const record = { source:"counts",period:null,missing:[],count:1234 };
    expect(checkNumbers("1 234", "", [record], "es").map(n => n.text)).toEqual(["234"]);
    expect(checkNumbers("1\u202f234", "", [record], "es")).toEqual([]);
    expect(checkNumbers("1\u00a0234", "", [record], "ar")).toEqual([]);
  });
  it("uses successful retries and actual missing evidence", () => {
    expect(statusFromResults([{callId:"a",name:"get_profit",arguments:'{"period":"month"}',result:{...base, missing:["first"]}},
      {callId:"new-retry-id",name:"get_profit",arguments:'{"period":"month"}',result:base}]).status).toBe("complete");
    expect(statusFromResults([{callId:"b",name:"get_sales",arguments:'{"period":"today"}',result:{...base,missing:["sales"]}}])).toEqual({
      status:"partial",missing:["sales"] });
  });
  it("publishes only three strict functions", () => {
    expect(agentToolDefinitions.map(t=>t.name)).toEqual(["get_profit","get_sales","get_menu_items",
      "get_staff","get_schedule","get_labor","get_business_hours","get_expenses","get_bills",
      "get_break_even","get_cost_summary","get_product_costs","get_ingredient_costs","get_inventory",
      "get_item_sales","get_price_recommendation"]);
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
    expect(result.agentId).toBe("alex");
    await expect(executeAgentTool("get_menu_items",{businessId:"other"},context)).rejects.toThrow();
    await expect(executeAgentTool("get_menu_items",{query:null,limit:26},context)).rejects.toThrow();
  });
});

describe("realistic multi-turn numeric claims",()=>{
  const menu={source:"menu_items",period:null,missing:[],
    items:[{id:"latte",name:"Latte",priceCents:850},{id:"mocha",name:"Mocha",priceCents:600}]};
  it("compares money in cents and accepts owner-supplied money",()=>{
    expect(checkNumbers("Latte is $8.50.","",[menu],"en")).toEqual([]);
    expect(checkNumbers("Latte is 8.50 dollars.","",[menu],"en")).toEqual([]);
    expect(checkNumbers("Latte is $6.","latte is 6",[],"en")).toEqual([]);
    expect(checkNumbers("Latte is $9.75.","",[menu],"en").map(v=>v.text)).toEqual(["$9.75"]);
    expect(checkNumbers("Latte is -$8.50.","",[menu],"en").map(v=>v.text)).toEqual(["-$8.50"]);
  });
  it("allows menu lists, time claims, and counts evidenced by array lengths",()=>{
    expect(checkNumbers("1. Latte 2. Mocha","",[],"en")).toEqual([]);
    expect(checkNumbers("2 drinks","",[menu],"en")).toEqual([]);
    expect(checkNumbers("We open at 7:00 AM","",[],"en")).toEqual([]);
    expect(checkNumbers("We open at 3 PM","",[],"en")).toEqual([]);
    expect(checkNumbers("We open at 15h","",[],"en")).toEqual([]);
  });
  it("keeps prior cents evidence across turns and validates supported differences",()=>{
    const saved=[{tool:"menu_items",values:[
      {key:"priceCents",value:850,unit:"cents" as const},
      {key:"priceCents",value:600,unit:"cents" as const},
    ]}];
    expect(checkNumbers("Latte costs $8.50.","",[],"en",saved)).toEqual([]);
    expect(checkNumbers("Latte is $2.50 more than Mocha.","",[],"en",saved)).toEqual([]);
    expect(checkNumbers("Latte costs $9.75.","",[],"en",saved).map(v=>v.text)).toEqual(["$9.75"]);
  });
});
