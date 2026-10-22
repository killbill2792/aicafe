import { describe, expect, it } from "vitest";
import { checkNumbers, compactEvidence } from "./checkNumbers";
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
    expect(checkNumbers("1 234", "", [record], "es").map(n => n.text)).toEqual(["1","234"]);
    expect(checkNumbers("1", "", [], "en").map(n => n.text)).toEqual(["1"]); // unsupported quantities are never inferred
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
    expect(checkNumbers("We open at 7:00 AM","We open at 7:00 AM",[],"en")).toEqual([]);
    expect(checkNumbers("We open at 3 PM","We open at 3 PM",[],"en")).toEqual([]);
    expect(checkNumbers("We open at 15h","We open at 15h",[],"en")).toEqual([]);
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

describe("Codex adversarial numbers and source units",()=>{
  it("never silently accepts unsupported staff or sales counts",()=>{
    expect(checkNumbers("You sold 9 drinks.","",[],"en").map(x=>x.text)).toEqual(["9"]);
    expect(checkNumbers("Nine? You sold 9 coffees.","",[],"en").map(x=>x.text)).toEqual(["9"]);
  });
  it("does not manufacture negated profit or doubled sales by arithmetic closure",()=>{
    const result={source:"profitability",period:null,missing:[],
      netSalesCents:20000,totalCostsCents:10000,ownerProfitCents:10000};
    expect(checkNumbers("Your profit is -$100","",[result],"en").map(x=>x.text)).toEqual(["-$100"]);
    expect(checkNumbers("Your sales were $400","",[result],"en").map(x=>x.text)).toEqual(["$400"]);
  });
  it("understands progress percentages and micro-cents in source-native units",()=>{
    expect(checkNumbers("63% progress","",[{source:"break_even",period:null,missing:[],
      estimate:{progressPercent:63}}],"en")).toEqual([]);
    expect(checkNumbers("Ingredient costs $0.02 per gram","",[{source:"ingredient_prices",period:null,missing:[],
      items:[{costPerBaseUnitMicros:2_000_000}]}],"en")).toEqual([]);
  });
  it("does not trust fabricated opening hours merely because they look like a clock",()=>{
    expect(checkNumbers("We open at 23:59","",[],"en").length).toBeGreaterThan(0);
  });
});

describe("owner quantity versus money evidence isolation",()=>{
  it("does not turn explicitly stated drink quantities into financial amounts",()=>{
    expect(checkNumbers("Your profit is $9.","We sold 9 drinks.",[],"en")
      .map(v=>v.text)).toEqual(["$9"]);
    expect(checkNumbers("The wage is $9.","We have 9 employees.",[],"en")
      .map(v=>v.text)).toEqual(["$9"]);
  });
  it("does treat an owner's stated menu price as money",()=>{
    expect(checkNumbers("Latte is $6.","latte is 6",[],"en")).toEqual([]);
    expect(checkNumbers("Rent costs $900.","Rent costs 900",[],"en")).toEqual([]);
  });
});

describe("fresh reads replace saved numeric evidence",()=>{
  const previous=[{tool:"menu_items",values:[{key:"items:latte/priceCents",
    value:600,unit:"cents" as const}]}];
  const fresh={source:"menu_items",period:null,missing:[],items:[{
    id:"latte",name:"Latte",priceCents:850,
  }]};
  it("rejects a superseded price even when it was verified on an earlier turn",()=>{
    expect(checkNumbers("Latte costs $6.","",[fresh],"en",previous,
      "The latte costs $6.").map(v=>v.text)).toEqual(["$6"]);
    expect(checkNumbers("Latte costs $8.50.","",[fresh],"en",previous)).toEqual([]);
  });
  it("still permits saved evidence in a no-tool follow-up",()=>{
    expect(checkNumbers("Latte costs $6.","",[],"en",previous)).toEqual([]);
  });
});

describe("Codex: list markers cannot hide unsupported facts", () => {
  it("flags sentence-ending business quantities rather than reading them as list numbers", () => {
    expect(checkNumbers("The order count is 999. Sales are unavailable.", "", [], "en")
      .map(v => v.text)).toEqual(["999"]);
    expect(checkNumbers("The order count is 9. Sales are unavailable.", "", [], "en")
      .map(v => v.text)).toEqual(["9"]);
    expect(checkNumbers("We sold 5. No order records were found.", "", [], "en")
      .map(v => v.text)).toEqual(["5"]);
    expect(checkNumbers("We sold 999) drinks.", "", [], "en")
      .map(v => v.text)).toEqual(["999"]);
    expect(checkNumbers("9. Sales are unavailable.", "", [], "en")
      .map(v => v.text)).toEqual(["9"]); // a number at line start is not automatically an ordered list
    expect(checkNumbers("2. Latte", "", [], "en")
      .map(v => v.text)).toEqual(["2"]); // a list with no first item is not proven to be a list
  });
  it("preserves real line-based and compact sequential numbered lists", () => {
    expect(checkNumbers("1. Latte\n2. Mocha\n3) Tea", "", [], "en")).toEqual([]);
    expect(checkNumbers("1. Latte 2. Mocha", "", [], "en")).toEqual([]);
    expect(checkNumbers("Our order count is 9. Revenue unknown.", "", [], "en")
      .map(v => v.text)).toEqual(["9"]);
    expect(checkNumbers("1 234", "", [], "en").map(v => v.text)).toEqual(["1","234"]);
  });
});

describe("Codex: typed money evidence cannot prove unrelated quantities", () => {
  const profit = {source:"profitability",period:null,missing:[],
    ownerProfitCents:8500, totalCostsCents:100};
  it("keeps money in cents rather than making it a generic count", () => {
    expect(checkNumbers("You sold 85 drinks.", "", [profit], "en")
      .map(v => v.text)).toEqual(["85"]);
    expect(checkNumbers("There were 85 staff members.", "", [profit], "en")
      .map(v => v.text)).toEqual(["85"]);
    expect(checkNumbers("You sold 85 drinks.", "", [], "en", [
      {tool:"profitability",values:[{key:"ownerProfitCents",value:8500,unit:"cents"}]},
    ]).map(v => v.text)).toEqual(["85"]);
    // The two money amounts have a numeric ratio of 85, but that ratio
    // is not evidence of 85 sold drinks.
    expect(checkNumbers("85 drinks sold", "", [profit], "en")
      .map(v => v.text)).toEqual(["85"]);
  });
  it("still allows currency-less amounts in their actual monetary context", () => {
    expect(checkNumbers("The profit was 85.", "", [profit], "en")).toEqual([]);
    expect(checkNumbers("The profit was $85.", "", [profit], "en")).toEqual([]);
    expect(checkNumbers("Profit 85, but you sold 85 drinks.", "", [profit], "en")
      .map(v => v.text)).toEqual(["85"]);
    expect(checkNumbers("La ganancia fue 85.", "", [profit], "es")).toEqual([]);
    expect(checkNumbers("Profit is 86.", "", [profit], "en")
      .map(v => v.text)).toEqual(["86"]);
  });
  it("keeps menu price wording valid without laundering product quantities", () => {
    const menu={source:"menu_items",period:null,missing:[],items:[{id:"latte",priceCents:850}]};
    expect(checkNumbers("Latte is 8.50.", "", [menu], "en")).toEqual([]);
    expect(checkNumbers("We sold 8.5 lattes.", "", [menu], "en")
      .map(v => v.text)).toEqual(["8.5"]);
  });
});


describe("Codex: semantic evidence and lexical formatting boundaries", () => {
  it("never retains counts derived from diagnostic and metadata arrays", () => {
    const profit={source:"profitability",period:null,missing:[],estimated:[],
      warnings:[],stale:[],ownerProfitCents:8500};
    const retained=compactEvidence([profit]);
    expect(retained.flatMap(r=>r.values).map(v=>v.key))
      .not.toEqual(expect.arrayContaining(["estimatedLength","warningsLength","staleLength"]));
    expect(checkNumbers("You sold 0 drinks.", "", [], "en", retained)
      .map(v=>v.text)).toEqual(["0"]);
    expect(checkNumbers("You sold 0 drinks.", "", [profit], "en")
      .map(v=>v.text)).toEqual(["0"]);
    const diagnostics={...profit,estimated:["taxes"],warnings:[{count:3}],stale:[1,2,3]};
    const saved=compactEvidence([diagnostics]);
    expect(checkNumbers("We sold 3 drinks.", "", [], "en", saved)
      .map(v=>v.text)).toEqual(["3"]);
    expect(checkNumbers("We sold 3 drinks.", "", [diagnostics], "en")
      .map(v=>v.text)).toEqual(["3"]);
  });
  it("retains actual business collection lengths across turns", () => {
    const menu={source:"menu_items",period:null,missing:[],
      items:[{id:"a",priceCents:450},{id:"b",priceCents:600}],estimated:[]};
    const saved=compactEvidence([menu]);
    expect(saved[0].values.some(v=>v.key==="itemsLength"&&v.value===2&&v.unit==="count"))
      .toBe(true);
    expect(checkNumbers("There are 2 menu items.", "", [], "en", saved)).toEqual([]);
    expect(checkNumbers("There are 3 menu items.", "", [], "en", saved)
      .map(v=>v.text)).toEqual(["3"]);
  });
  it("never mistakes a nearby clock for the sales figure itself", () => {
    expect(checkNumbers("We sold 999 (8:00).", "", [], "en")
      .map(v=>v.text)).toEqual(["999"]);
    expect(checkNumbers("Orders: 999, 8:00 AM.", "", [], "en")
      .map(v=>v.text)).toEqual(["999"]);
    expect(checkNumbers("We sold 9 at 3 PM.", "", [], "en")
      .map(v=>v.text)).toEqual(["9"]);
    expect(checkNumbers("We sold 15 at 15h.", "", [], "en")
      .map(v=>v.text)).toEqual(["15"]);
    expect(checkNumbers("We sold 999 (8:00).", "We sold 999", [], "en")).toEqual([]);
  });
  it("validates an actual business clock against owner words or tool evidence", () => {
    expect(checkNumbers("We open at 8:00 AM.", "", [], "en").length).toBeGreaterThan(0);
    expect(checkNumbers("We open at 8:00 AM.", "We open at 8:00 AM.", [], "en")).toEqual([]);
    const hours={source:"business_hours",period:null,missing:[],
      weekly:{mon:[["08:00","17:00"]]}};
    expect(checkNumbers("We open at 8:00 AM.", "", [hours], "en")).toEqual([]);
    expect(checkNumbers("We open at 9:00 AM.", "", [hours], "en").length).toBeGreaterThan(0);
  });
  it("honors blank lines in a verified sequential list, but not unrelated claims", () => {
    expect(checkNumbers("1. Latte\n\n2. Mocha\n\n3. Tea", "", [], "en")).toEqual([]);
    expect(checkNumbers("1) Latte\n \n 2) Mocha\n\n  3) Tea", "", [], "en")).toEqual([]);
    expect(checkNumbers("1. Latte\n\n9. No sales recorded", "", [], "en")
      .map(v=>v.text)).toEqual(["9"]);
    expect(checkNumbers("The order count is 999. Sales are unavailable.", "", [], "en")
      .map(v=>v.text)).toEqual(["999"]);
  });
});
