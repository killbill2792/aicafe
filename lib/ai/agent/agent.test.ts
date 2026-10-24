import { describe, expect, it } from "vitest";
import { checkNumbers, compactEvidence, numberProvenance } from "./checkNumbers";
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
  it("publishes exactly the registered strict functions", () => {
    expect(agentToolDefinitions.map(t=>t.name)).toEqual(["get_peak_hours","get_employee_sales","get_payroll_facts","get_profit","get_sales","get_menu_items",
      "get_staff","get_schedule","get_labor","get_team","get_week_schedule","get_labor_rules",
      "get_coverage_gaps","get_shift_cost","get_business_hours","get_expenses","get_bills",
      "get_break_even","get_cost_summary","get_usage_variance","get_product_costs","get_ingredient_costs","get_inventory",
      "get_item_sales","get_price_recommendation","draft_week_schedule","suggest_new_item_price","propose_price_change",
      "propose_schedule","propose_shift_change","propose_add_staff","propose_staff_change",
      "propose_availability_change","propose_rule_change","propose_send_schedule",
      "get_initiatives","get_initiative_status","record_checkin"]);
    expect(agentToolDefinitions.every(t=>t.strict)).toBe(true);
    expect(agentToolDefinitions.some(t=>t.name==="propose_initiative")).toBe(false);
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
      {key:"items:latte/priceCents",value:850,unit:"cents" as const},
      {key:"items:mocha/priceCents",value:600,unit:"cents" as const},
    ],prices:[{id:"latte",name:"Latte",priceCents:850},
      {id:"mocha",name:"Mocha",priceCents:600}]}];
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
    expect(checkNumbers("Latte costs $6.","",[fresh],"en",previous)
      .map(v=>v.text)).toEqual(["$6"]);
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


describe("Codex: assistant formatting never becomes cross-turn evidence", () => {
  it("does not trust previous assistant list markers or unsupported time digits", () => {
    // Only owner statements and typed evidence can be passed to checkNumbers;
    // there is deliberately no previousAssistantText input to launder markers.
    expect(checkNumbers("You sold 2 drinks.", "", [], "en")
      .map(v=>v.text)).toEqual(["2"]);
    expect(checkNumbers("We served 8 drinks.", "", [], "en")
      .map(v=>v.text)).toEqual(["8"]);
    expect(checkNumbers("You sold 2 drinks.", "We sold 2 drinks.", [], "en"))
      .toEqual([]);
  });
});

describe("Codex: partial hours preserve weekday-specific verified times", () => {
  const partial={source:"locations.open_hours",period:null,
    missing:["businessHoursNotSet:tue","businessHoursNotSet:wed"],
    hours:{mon:[["08:00","17:00"]]}};
  it("verifies a configured Monday time even when other weekdays are unknown", () => {
    expect(checkNumbers("We open at 8:00 AM on Monday.", "", [partial], "en")).toEqual([]);
    expect(checkNumbers("We close at 5:00 PM on Monday.", "", [partial], "en")).toEqual([]);
  });
  it("does not transfer Monday evidence to unknown Tuesday or unlabeled weekdays", () => {
    expect(checkNumbers("We open at 8:00 AM on Tuesday.", "", [partial], "en")
      .length).toBeGreaterThan(0);
    expect(checkNumbers("We open at 8:00 AM.", "", [partial], "en")
      .length).toBeGreaterThan(0);
    expect(checkNumbers("We open at 10:00 AM on Monday.", "", [partial], "en")
      .length).toBeGreaterThan(0);
    expect(checkNumbers("We open at 8:00 AM on Monday and Tuesday.", "", [partial], "en")
      .length).toBeGreaterThan(0);
  });
  it("retains multilingual weekday-specific grounding", () => {
    expect(checkNumbers("We open at 8:00 AM on lunes.", "", [partial], "es")).toEqual([]);
    expect(checkNumbers("We open at 8:00 AM on الاثنين.", "", [partial], "ar")).toEqual([]);
  });
});


describe("Codex: typed roles, weekdays and staff identity in time evidence", () => {
  const hours={source:"locations.open_hours",period:null,missing:[],
    hours:{mon:[["08:00","17:00"]],tue:[["09:00","18:00"]]}};
  const schedule={source:"recurring_schedule",period:{from:"2026-10-26",to:"2026-11-01"},
    missing:[],shifts:[{displayName:"Ada",dayOfWeek:1,startTime:"08:00",
      endTime:"16:00",effectiveFrom:"2026-10-26",effectiveTo:null}]};
  it("does not interchange opening and closing endpoints", () => {
    expect(checkNumbers("We open at 8:00 AM on Monday.", "", [hours], "en")).toEqual([]);
    expect(checkNumbers("We close at 5:00 PM on Monday.", "", [hours], "en")).toEqual([]);
    expect(checkNumbers("We open at 5:00 PM on Monday.", "", [hours], "en")
      .length).toBeGreaterThan(0);
    expect(checkNumbers("We close at 8:00 AM on Monday.", "", [hours], "en")
      .length).toBeGreaterThan(0);
  });
  it("matches each time with its respective weekday in a shared sentence", () => {
    expect(checkNumbers("We open at 8:00 AM on Monday and 9:00 AM on Tuesday.",
      "", [hours], "en")).toEqual([]);
    expect(checkNumbers("We open Monday at 8:00 AM and Tuesday at 9:00 AM.",
      "", [hours], "en")).toEqual([]);
    expect(checkNumbers("We open at 8:00 AM on Monday and Tuesday.",
      "", [hours], "en").length).toBeGreaterThan(0);
    const shared={...hours,hours:{mon:[["08:00","17:00"]],tue:[["08:00","18:00"]]}};
    expect(checkNumbers("We open at 8:00 AM on Monday and Tuesday.",
      "", [shared], "en")).toEqual([]);
  });
  it("does not use Ada's Monday shift to prove a Tuesday shift or location opening", () => {
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday.",
      "", [schedule], "en")).toEqual([]);
    expect(checkNumbers("Ada’s shift ends at 4:00 PM on Monday.",
      "", [schedule], "en")).toEqual([]);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Tuesday.",
      "", [schedule], "en").length).toBeGreaterThan(0);
    expect(checkNumbers("Bob’s shift starts at 8:00 AM on Monday.",
      "", [schedule], "en").length).toBeGreaterThan(0);
    expect(checkNumbers("Ada’s shift ends at 8:00 AM on Monday.",
      "", [schedule], "en").length).toBeGreaterThan(0);
    expect(checkNumbers("We open at 8:00 AM on Tuesday.",
      "", [schedule], "en").length).toBeGreaterThan(0);
    expect(checkNumbers("We open at 8:00 AM on Monday.",
      "", [schedule], "en").length).toBeGreaterThan(0);
  });
});


describe("Owner-reported times retain semantic context",()=>{
  it("does not promote the owner's shift time into unrelated opening hours",()=>{
    const owner="Ada’s shift starts at 8:00 AM on Monday.";
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday.",owner,[],"en")).toEqual([]);
    expect(checkNumbers("We open at 8:00 AM on Monday.",owner,[],"en")
      .length).toBeGreaterThan(0);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Tuesday.",owner,[],"en")
      .length).toBeGreaterThan(0);
  });
  it("does not use an owner-described opening as evidence for closing",()=>{
    const owner="We open at 8:00 AM on Monday.";
    expect(checkNumbers(owner,owner,[],"en")).toEqual([]);
    expect(checkNumbers("We close at 8:00 AM on Monday.",owner,[],"en")
      .length).toBeGreaterThan(0);
  });
});


describe("Codex: localized time actions and qualified shift identities",()=>{
  const hours={source:"locations.open_hours",period:null,missing:["businessHoursNotSet:tue"],
    hours:{mon:[["08:00","17:00"]]}};
  const ada={source:"recurring_schedule",period:{from:"2026-10-26",to:"2026-11-01"},missing:[],
    shifts:[{displayName:"Ada",dayOfWeek:1,startTime:"08:00",endTime:"16:00"}]};
  it("does not exempt unsupported Spanish and Arabic opening statements",()=>{
    expect(checkNumbers("Abrimos a las 23:59 el lunes.","",[],"es")
      .length).toBeGreaterThan(0);
    expect(checkNumbers("نفتح الساعة 23:59 يوم الاثنين.","",[],"ar")
      .length).toBeGreaterThan(0);
    expect(checkNumbers("Abrimos a las 8:00 el lunes.","",[hours],"es")).toEqual([]);
    expect(checkNumbers("نفتح الساعة 8:00 يوم الاثنين.","",[hours],"ar")).toEqual([]);
    expect(checkNumbers("Cerramos a las 8:00 el lunes.","",[hours],"es")
      .length).toBeGreaterThan(0);
  });
  it("understands shift-start paraphrases instead of bypassing them",()=>{
    expect(checkNumbers("Bob starts his shift at 23:59 on Monday.","",[],"en")
      .length).toBeGreaterThan(0);
    expect(checkNumbers("Bob starts his shift at 8:00 AM on Monday.","",[ada],"en")
      .length).toBeGreaterThan(0);
    expect(checkNumbers("Ada starts her shift at 8:00 AM on Monday.","",[ada],"en"))
      .toEqual([]);
  });
  it("retains the asserted employee across shift qualifiers and following names",()=>{
    expect(checkNumbers("Bob’s morning shift starts at 8:00 AM on Monday.","",[ada],"en")
      .length).toBeGreaterThan(0);
    expect(checkNumbers("Ada’s morning shift starts at 8:00 AM on Monday.","",[ada],"en"))
      .toEqual([]);
    expect(checkNumbers("The shift starts at 8:00 AM on Monday for Bob.","",[ada],"en")
      .length).toBeGreaterThan(0);
    expect(checkNumbers("The shift starts at 8:00 AM on Monday for Ada.","",[ada],"en"))
      .toEqual([]);
    const owner="Ada’s shift starts at 8:00 AM on Monday.";
    expect(checkNumbers("Bob’s morning shift starts at 8:00 AM on Monday.",
      owner,[],"en").length).toBeGreaterThan(0);
    expect(checkNumbers("The shift starts at 8:00 AM on Monday for Bob.",
      owner,[],"en").length).toBeGreaterThan(0);
  });
});


describe("Codex: immutable evidence semantics for dates, counts, names and ranges",()=>{
  const schedule={source:"recurring_schedule",period:{from:"2026-11-02",to:"2026-11-08"},
    missing:[],shifts:[{displayName:"Ada",dayOfWeek:1,startTime:"08:00",endTime:"16:00",
      effectiveFrom:"2026-11-02",effectiveTo:"2026-11-30"},
      {displayName:"Ada",dayOfWeek:6,startTime:"09:00",endTime:"15:00",
        effectiveFrom:"2026-11-02",effectiveTo:"2026-11-30"}]};
  it("does not recycle weekday enum 6 as a drinks-sold count, now or next turn",()=>{
    const saturdays={...schedule,shifts:[
      {displayName:"Ada",dayOfWeek:6,startTime:"09:00",endTime:"15:00",
        effectiveFrom:"2026-11-02",effectiveTo:"2026-11-30"},
      {displayName:"Bob",dayOfWeek:6,startTime:"10:00",endTime:"16:00",
        effectiveFrom:"2026-11-02",effectiveTo:"2026-11-30"}]};
    const saved=compactEvidence([saturdays]);
    expect(saved.flatMap(x=>x.values).filter(v=>v.unit==="count").map(v=>v.value)).toEqual([2]);
    expect(checkNumbers("You sold 6 drinks.","",[saturdays],"en").map(x=>x.text)).toEqual(["6"]);
    expect(checkNumbers("You sold 6 drinks.","",[],"en",saved).map(x=>x.text)).toEqual(["6"]);
    const oldSaved=[{tool:"recurring_schedule",values:[{
      key:"shifts:ada/dayOfWeek",value:6,unit:"count" as const}]}];
    expect(checkNumbers("You sold 6 drinks.","",[],"en",oldSaved).map(x=>x.text)).toEqual(["6"]);
  });
  it("checks a claimed schedule date against period, effective window and weekday",()=>{
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday, October 26, 2026.",
      "",[schedule],"en").length).toBeGreaterThan(0);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday, November 2, 2026.",
      "",[schedule],"en")).toEqual([]);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday, November 9, 2026.",
      "",[schedule],"en").length).toBeGreaterThan(0);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Tuesday, November 2, 2026.",
      "",[schedule],"en").length).toBeGreaterThan(0);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on 2026-11-02.",
      "",[schedule],"en")).toEqual([]);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on 2026-10-26.",
      "",[schedule],"en").length).toBeGreaterThan(0);
  });
  it("does not use the owner's statement about a different date as evidence",()=>{
    const owner="Ada’s shift starts at 8:00 AM on Monday, November 2, 2026.";
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday, October 26, 2026.",
      owner,[],"en").length).toBeGreaterThan(0);
  });
  it("recognizes employee boundaries beside weekday words and prepositions",()=>{
    expect(checkNumbers("On Monday Ada’s shift starts at 8:00 AM.",
      "",[schedule],"en")).toEqual([]);
    expect(checkNumbers("On Monday Ada starts her shift at 8:00 AM.",
      "",[schedule],"en")).toEqual([]);
    expect(checkNumbers("The shift starts at 8:00 AM for Ada on Monday.",
      "",[schedule],"en")).toEqual([]);
    expect(checkNumbers("On Monday Bob’s shift starts at 8:00 AM.",
      "",[schedule],"en").length).toBeGreaterThan(0);
    expect(checkNumbers("The shift starts at 8:00 AM for Bob on Monday.",
      "",[schedule],"en").length).toBeGreaterThan(0);
  });
  it("interprets opening-hour ranges as distinct opening and closing facts",()=>{
    const hours={source:"locations.open_hours",period:null,missing:[],
      hours:{mon:[["08:00","17:00"]]}};
    expect(checkNumbers("We open from 8:00 AM to 5:00 PM on Monday.",
      "",[hours],"en")).toEqual([]);
    expect(checkNumbers("We open from 8:00 AM to 6:00 PM on Monday.",
      "",[hours],"en").length).toBeGreaterThan(0);
    expect(checkNumbers("We open from 7:00 AM to 5:00 PM on Monday.",
      "",[hours],"en").length).toBeGreaterThan(0);
  });
});


describe("Codex: chronological evidence and claim-local calculations",()=>{
  const before={tool:"menu_items",values:[{
    key:"items:latte/priceCents",value:600,unit:"cents" as const}]};
  const after={tool:"menu_items",values:[{
    key:"items:latte/priceCents",value:850,unit:"cents" as const}]};
  it("supersedes saved prices on a subsequent no-read turn, rather than resurrecting them",()=>{
    expect(checkNumbers("The latte costs $6.","",[],"en",[before,after])
      .map(v=>v.text)).toEqual(["$6"]);
    expect(checkNumbers("The latte costs $8.50.","",[],"en",[before,after])).toEqual([]);
    expect(checkNumbers("The latte costs $8.50.","",[],"en",[after,before])
      .map(v=>v.text)).toEqual(["$8.50"]);
    const legacy={tool:"menu_items",values:[{
      key:"priceCents",value:600,unit:"cents" as const}]};
    expect(checkNumbers("The latte costs $6.","",[],"en",[legacy,after])
      .map(v=>v.text)).toEqual(["$6"]);
  });
  it("does not turn unrelated comparison prose into arithmetic evidence",()=>{
    const profit={source:"profitability",period:null,missing:[],
      netSalesCents:20000,totalCostsCents:10000,ownerProfitCents:10000};
    expect(checkNumbers("Your profit is -$100. This is an increase.",
      "",[profit],"en").map(v=>v.text)).toEqual(["-$100"]);
    expect(checkNumbers("Your profit is -$100 more than costs.",
      "",[profit],"en").map(v=>v.text)).toEqual(["-$100"]);
    expect(checkNumbers("Your sales are $400, which is an increase.",
      "",[profit],"en").map(v=>v.text)).toEqual(["$400"]);
    const menu={source:"menu_items",period:null,missing:[],items:[
      {id:"latte",name:"Latte",priceCents:850},{id:"mocha",name:"Mocha",priceCents:600}]};
    expect(checkNumbers("Latte is $2.50 more than Mocha.","",[menu],"en")).toEqual([]);
    expect(checkNumbers("Profit is $2.50 more than yesterday.","",[menu],"en")
      .map(v=>v.text)).toEqual(["$2.50"]);
  });
  it("keeps slash and hyphen dates equally bounded by the shift's active period",()=>{
    const schedule={source:"recurring_schedule",period:{from:"2026-11-02",to:"2026-11-08"},
      missing:[],shifts:[{displayName:"Ada",dayOfWeek:1,startTime:"08:00",
        endTime:"16:00",effectiveFrom:"2026-11-02",effectiveTo:"2026-11-30"}]};
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday, 2026/10/26.",
      "",[schedule],"en").length).toBeGreaterThan(0);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday, 2026/11/02.",
      "",[schedule],"en")).toEqual([]);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday, 2026-11-02.",
      "",[schedule],"en")).toEqual([]);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday, 10/26/2026.",
      "",[schedule],"en").length).toBeGreaterThan(0);
  });
  it("recognizes attendance reader counts in live and retained results",()=>{
    const attendance={source:"labor_and_attendance",period:null,missing:[],
      attendance:{timecardCount:7,onClockCount:3}};
    const claim="There are 7 timecards and 3 people on the clock.";
    expect(checkNumbers(claim,"",[attendance],"en")).toEqual([]);
    expect(checkNumbers(claim,"",[],"en",compactEvidence([attendance]))).toEqual([]);
    expect(checkNumbers("There are 8 timecards.","",[attendance],"en")
      .map(v=>v.text)).toEqual(["8"]);
  });
});


describe("Codex: typed partial updates and temporal cross-turn evidence",()=>{
  const savedMenu={source:"menu_items",period:null,missing:[],
    items:[{id:"latte",name:"Latte",priceCents:600}]};
  const partialMenu={source:"menu_items",period:null,missing:["moreMenuItems"],
    items:[{id:"latte",name:"Latte",priceCents:850}]};
  it("supersedes matching observed keys even when other menu rows are truncated",()=>{
    const old=compactEvidence([savedMenu]),fresh=compactEvidence([partialMenu]);
    expect(fresh.flatMap(e=>e.values).some(v=>v.key==="items:latte/priceCents"&&v.value===850))
      .toBe(true);
    expect(checkNumbers("Latte costs $6.","",[partialMenu],"en",old)
      .map(v=>v.text)).toEqual(["$6"]);
    expect(checkNumbers("Latte costs $8.50.","",[partialMenu],"en",old)).toEqual([]);
    expect(checkNumbers("Latte costs $6.","",[],"en",[...old,...fresh])
      .map(v=>v.text)).toEqual(["$6"]);
    expect(checkNumbers("Latte costs $8.50.","",[],"en",[...old,...fresh])).toEqual([]);
  });
  it("keeps typed partial Monday opening hours across a no-read follow-up",()=>{
    const partial={source:"locations.open_hours",period:null,missing:["businessHoursNotSet:tue"],
      hours:{mon:[["08:00","17:00"]]}};
    const saved=compactEvidence([partial]);
    expect(saved).toHaveLength(1);
    expect(saved[0].times).toEqual(expect.arrayContaining([
      expect.objectContaining({day:"mon",time:"08:00",role:"open"}),
      expect.objectContaining({day:"mon",time:"17:00",role:"close"}),
    ]));
    expect(checkNumbers("We open at 8:00 AM on Monday.","",[],"en",saved)).toEqual([]);
    expect(checkNumbers("We close at 5:00 PM on Monday.","",[],"en",saved)).toEqual([]);
    expect(checkNumbers("We open at 8:00 AM on Tuesday.","",[],"en",saved)
      .length).toBeGreaterThan(0);
    expect(checkNumbers("We open at 5:00 PM on Monday.","",[],"en",saved)
      .length).toBeGreaterThan(0);
  });
  it("replaces an older opening-time snapshot when new observed hours arrive",()=>{
    const old=compactEvidence([{source:"locations.open_hours",period:null,missing:[],
      hours:{mon:[["07:00","15:00"]]}}]);
    const newer=compactEvidence([{source:"locations.open_hours",period:null,missing:["businessHoursNotSet:tue"],
      hours:{mon:[["08:00","17:00"]]}}]);
    expect(checkNumbers("We open at 7:00 AM on Monday.","",[],"en",[...old,...newer])
      .length).toBeGreaterThan(0);
    expect(checkNumbers("We open at 8:00 AM on Monday.","",[],"en",[...old,...newer])).toEqual([]);
  });
  it("applies a shared trailing date to both a shift's starting and ending clocks",()=>{
    const schedule={source:"recurring_schedule",period:{from:"2026-11-02",to:"2026-11-08"},
      missing:[],shifts:[{displayName:"Ada",dayOfWeek:1,startTime:"08:00",
        endTime:"16:00",effectiveFrom:"2026-11-02",effectiveTo:"2026-11-30"}]};
    const bad="Ada’s shift starts at 8:00 AM and her shift ends at 4:00 PM on Monday, 2026-10-26.";
    expect(checkNumbers(bad,"",[schedule],"en").map(v=>v.text))
      .toEqual(["8:00 AM","4:00 PM"]);
    const good="Ada’s shift starts at 8:00 AM and her shift ends at 4:00 PM on Monday, 2026-11-02.";
    expect(checkNumbers(good,"",[schedule],"en")).toEqual([]);
    expect(checkNumbers(good,"",[],"en",compactEvidence([schedule]))).toEqual([]);
  });
  it("matches Arabic digits to typed hour evidence without losing source offsets",()=>{
    const hours={source:"locations.open_hours",period:null,missing:[],
      hours:{mon:[["08:00","17:00"]]}};
    const saved=compactEvidence([hours]);
    expect(checkNumbers("نفتح الساعة ٠٨:٠٠ يوم الاثنين.","",[hours],"ar")).toEqual([]);
    expect(checkNumbers("نفتح الساعة ٠٨:٠٠ يوم الاثنين.","",[],"ar",saved)).toEqual([]);
    expect(checkNumbers("نفتح الساعة ٢٣:٥٩ يوم الاثنين.","",[hours],"ar")
      .length).toBeGreaterThan(0);
  });
});


describe("Codex: observation scopes, source identities and comparison operands",()=>{
  const monday={source:"locations.open_hours",period:null,missing:[],
    hours:{mon:[["08:00","17:00"]]}};
  it("retains an explicit closed-day refresh and invalidates saved opening times",()=>{
    const prior=compactEvidence([monday]);
    const closed={source:"locations.open_hours",period:null,missing:["businessHoursNotSet:tue"],
      hours:{mon:[]}};
    const refresh=compactEvidence([closed]);
    expect(refresh).toHaveLength(1);
    expect(refresh[0].timeScope).toEqual({kind:"hours",days:["mon","tue"]});
    expect(refresh[0].times).toEqual([]);
    expect(checkNumbers("We open at 8:00 AM on Monday.","",[closed],"en",prior)
      .length).toBeGreaterThan(0);
    expect(checkNumbers("We open at 8:00 AM on Monday.","",[],"en",
      [...prior,...refresh]).length).toBeGreaterThan(0);
  });
  it("observes fresh values before the 100-value persistence cap",()=>{
    const earlier=compactEvidence([{source:"menu_items",period:null,missing:[],
      items:[{id:"latte",name:"Latte",priceCents:600}]}]);
    const labor={source:"labor_and_attendance",period:null,missing:[],
      laborDays:Array.from({length:31},(_,i)=>({date:"2026-10-"+String(i+1).padStart(2,"0"),
        wagesCents:1500,staffTaxCents:100,loadedStaffCostCents:1600}))};
    const menu={source:"menu_items",period:null,missing:[],
      items:["A","B","C","D","E"].map((name,i)=>({id:name,name,priceCents:500+i*100}))
        .concat([{id:"latte",name:"Latte",priceCents:850}])};
    const persisted=compactEvidence([labor,menu]);
    expect(persisted.flatMap(x=>x.values).length).toBeLessThanOrEqual(100);
    expect(persisted.flatMap(x=>x.values).some(v=>
      v.key==="items:latte/priceCents"&&v.value===850)).toBe(true);
    expect(checkNumbers("Latte costs $6.","",[labor,menu],"en",earlier)
      .map(v=>v.text)).toEqual(["$6"]);
    expect(checkNumbers("Latte costs $6.","",[],"en",earlier.concat(persisted))
      .map(v=>v.text)).toEqual(["$6"]);
    expect(checkNumbers("Latte costs $8.50.","",[],"en",earlier.concat(persisted))).toEqual([]);
    expect(checkNumbers("B costs $6.","",[],"en",earlier.concat(persisted))).toEqual([]);
  });
  it("shares a trailing weekday across both ends of a true hours range",()=>{
    const hours={source:"locations.open_hours",period:null,missing:[],
      hours:{mon:[["08:00","17:00"]],tue:[["09:00","18:00"]]}};
    expect(checkNumbers("We open from 8:00 AM to 6:00 PM on Tuesday.",
      "",[hours],"en").length).toBeGreaterThan(0);
    expect(checkNumbers("We open from 9:00 AM to 6:00 PM on Tuesday.",
      "",[hours],"en")).toEqual([]);
    expect(checkNumbers("We open from 8:00 AM to 5:00 PM on Monday.",
      "",[hours],"en")).toEqual([]);
    expect(checkNumbers("We open at 8:00 AM on Monday and 9:00 AM on Tuesday.",
      "",[hours],"en")).toEqual([]);
  });
  it("tracks named employees in Spanish shift assertions",()=>{
    const schedule={source:"recurring_schedule",period:{from:"2026-11-02",to:"2026-11-08"},
      missing:[],shifts:[{displayName:"Ada",dayOfWeek:1,startTime:"08:00",endTime:"16:00",
        effectiveFrom:"2026-11-02",effectiveTo:null}]};
    expect(checkNumbers("El turno de Bob empieza a las 8:00 el lunes.",
      "",[schedule],"es").length).toBeGreaterThan(0);
    expect(checkNumbers("El turno de Ada empieza a las 8:00 el lunes.",
      "",[schedule],"es")).toEqual([]);
  });
  it("keeps nonoverlapping schedule periods and invalidates overlapping windows",()=>{
    const ada={source:"recurring_schedule",period:{from:"2026-11-02",to:"2026-11-08"},missing:[],
      shifts:[{displayName:"Ada",dayOfWeek:1,startTime:"08:00",endTime:"16:00",
        effectiveFrom:"2026-11-02",effectiveTo:null}]};
    const bob={source:"recurring_schedule",period:{from:"2026-11-09",to:"2026-11-15"},missing:[],
      shifts:[{displayName:"Bob",dayOfWeek:2,startTime:"09:00",endTime:"17:00",
        effectiveFrom:"2026-11-09",effectiveTo:null}]};
    const saved=[...compactEvidence([ada]),...compactEvidence([bob])];
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday, 2026-11-02.",
      "",[],"en",saved)).toEqual([]);
    expect(checkNumbers("Bob’s shift starts at 9:00 AM on Tuesday, 2026-11-10.",
      "",[],"en",saved)).toEqual([]);
    const changed={...ada,shifts:[{displayName:"Ada",dayOfWeek:1,
      startTime:"10:00",endTime:"16:00",effectiveFrom:"2026-11-02",effectiveTo:null}]};
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday, 2026-11-02.",
      "",[],"en",[...saved,...compactEvidence([changed])]).length).toBeGreaterThan(0);
    expect(checkNumbers("Bob’s shift starts at 9:00 AM on Tuesday, 2026-11-10.",
      "",[],"en",[...saved,...compactEvidence([changed])])).toEqual([]);
  });
  it("keeps singleton and root item identifiers in price keys",()=>{
    const cost=(id:string,priceCents:number)=>({source:"product_costs",period:null,
      missing:[],item:{id,name:id,priceCents}});
    const saved=[...compactEvidence([cost("latte",600)]),
      ...compactEvidence([cost("mocha",850)])];
    expect(saved[0].values.some(v=>v.key==="item:latte/priceCents")).toBe(true);
    expect(saved[1].values.some(v=>v.key==="item:mocha/priceCents")).toBe(true);
    expect(checkNumbers("Latte costs $6.","",[],"en",saved)).toEqual([]);
    const root=compactEvidence([{source:"pricing_engine",period:null,missing:[],
      itemId:"latte",currentPriceCents:600}]);
    expect(root[0].values[0].key).toBe("item:latte/currentPriceCents");
  });
  it("does not mistake employee names containing month prefixes for dates",()=>{
    for(const name of ["Mark","Mary","Marcus","Omar"]){
      const schedule={source:"recurring_schedule",period:{from:"2026-11-02",to:"2026-11-08"},
        missing:[],shifts:[{displayName:name,dayOfWeek:1,startTime:"08:00",
          endTime:"16:00",effectiveFrom:"2026-11-02",effectiveTo:null}]};
      expect(checkNumbers(name+"’s shift starts at 8:00 AM on Monday.",
        "",[schedule],"en")).toEqual([]);
    }
  });
  it("requires actual item identities and comparison direction in computed deltas",()=>{
    const menu={source:"menu_items",period:null,missing:[],
      items:[{id:"latte",name:"Latte",priceCents:850},
        {id:"mocha",name:"Mocha",priceCents:600},
        {id:"tea",name:"Tea",priceCents:450}]};
    expect(checkNumbers("Latte is $2.50 more than Mocha.","",[menu],"en")).toEqual([]);
    expect(checkNumbers("Mocha is $2.50 less than Latte.","",[menu],"en")).toEqual([]);
    expect(checkNumbers("Tea is $2.50 more than Latte.","",[menu],"en")
      .map(v=>v.text)).toEqual(["$2.50"]);
    expect(checkNumbers("Mocha is $2.50 more than Latte.","",[menu],"en")
      .map(v=>v.text)).toEqual(["$2.50"]);
    expect(checkNumbers("Tea is $1.50 less than Mocha.","",[menu],"en")).toEqual([]);
    expect(checkNumbers("Profit is $2.50 more than yesterday.","",[menu],"en")
      .map(v=>v.text)).toEqual(["$2.50"]);
  });
});


describe("named-price isolation from unrelated menu values",()=>{
  const menu={source:"menu_items",period:null,missing:[],items:[
    {id:"latte",name:"Latte",priceCents:850},
    {id:"mocha",name:"Mocha",priceCents:600}]};
  it("does not use Mocha's $6 to verify Latte at $6",()=>{
    expect(checkNumbers("Latte costs $6.","",[menu],"en").map(v=>v.text)).toEqual(["$6"]);
    expect(checkNumbers("Latte costs $8.50.","",[menu],"en")).toEqual([]);
    expect(checkNumbers("Mocha is $6.","",[menu],"en")).toEqual([]);
    expect(checkNumbers("Mocha is $8.50.","",[menu],"en").map(v=>v.text)).toEqual(["$8.50"]);
  });
});


describe("failed read versus explicitly absent temporal data",()=>{
  it("clears old hours after the source explicitly reports no configuration",()=>{
    const old=compactEvidence([{source:"locations.open_hours",period:null,missing:[],
      hours:{mon:[["08:00","17:00"]]}}]);
    const cleared=compactEvidence([{source:"locations.open_hours",period:null,
      missing:["businessHoursNotSet"],hours:null}]);
    expect(cleared[0].timeScope?.kind).toBe("hours");
    expect(checkNumbers("We open at 8:00 AM on Monday.","",[],"en",
      [...old,...cleared]).length).toBeGreaterThan(0);
  });
  it("does not erase a verified schedule on an unsuccessful later read",()=>{
    const old=compactEvidence([{source:"recurring_schedule",
      period:{from:"2026-11-02",to:"2026-11-08"},missing:[],
      shifts:[{displayName:"Ada",dayOfWeek:1,startTime:"08:00",
        endTime:"16:00",effectiveFrom:"2026-11-02",effectiveTo:null}]}]);
    const failed=compactEvidence([{source:"recurring_schedule",
      period:{from:"2026-11-02",to:"2026-11-08"},
      missing:["scheduleReaderUnavailable"]}]);
    expect(failed).toEqual([]);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday, 2026-11-02.",
      "",[],"en",[...old,...failed])).toEqual([]);
  });
});


describe("Codex: scoped invalidations, item identity and Arabic clocks",()=>{
  const oldTuesday={source:"locations.open_hours",period:null,missing:[],
    hours:{mon:[["08:00","17:00"]],tue:[["09:00","18:00"]]}};
  const partial={source:"locations.open_hours",period:null,
    missing:["businessHoursNotSet:tue","businessHoursNotSet:wed"],
    hours:{mon:[["08:00","17:00"]]}};
  it("invalidates specifically unset weekdays without dropping known Monday",()=>{
    const previous=compactEvidence([oldTuesday]);
    const updated=compactEvidence([partial]);
    expect(updated[0].timeScope).toEqual({kind:"hours",days:["mon","tue","wed"]});
    expect(checkNumbers("We open at 9:00 AM on Tuesday.","",[],"en",
      [...previous,...updated]).length).toBeGreaterThan(0);
    expect(checkNumbers("We open at 8:00 AM on Monday.","",[],"en",
      [...previous,...updated])).toEqual([]);
    const failed=compactEvidence([{source:"locations.open_hours",period:null,
      missing:["businessHoursReaderUnavailable"],hours:null}]);
    expect(checkNumbers("We open at 9:00 AM on Tuesday.","",[],"en",
      [...previous,...failed])).toEqual([]);
  });
  it("keeps numeric invalidations even when all 100 persistence slots are used",()=>{
    const previous=compactEvidence([{source:"expenses",period:null,missing:[],
      recordedActualTotalCents:600}]);
    const current=[
      {source:"expenses",period:null,missing:[],recordedActualTotalCents:850},
      {source:"labor_and_attendance",period:null,missing:[],
        laborDays:Array.from({length:31},(_,i)=>({
          date:"2026-10-"+String(i+1).padStart(2,"0"),
          wagesCents:1000+i,staffTaxCents:100,loadedStaffCostCents:1100+i}))},
      {source:"menu_items",period:null,missing:[],
        items:Array.from({length:25},(_,i)=>({
          id:"item-"+i,name:"Item "+i,priceCents:300+i}))}
    ];
    const newSaved=compactEvidence(current);
    expect(newSaved[0].values).toHaveLength(0);
    expect(newSaved[0].invalidatedKeys).toContain("recordedActualTotalCents");
    expect(checkNumbers("Recorded expenses are $6.","",[],"en",
      [...previous,...newSaved]).map(x=>x.text)).toEqual(["$6"]);
  });
  it("reconciles a named product price read through another tool",()=>{
    const old=compactEvidence([{source:"menu_items",period:null,missing:[],
      items:[{id:"latte",name:"Latte",priceCents:600}]}]);
    const current=compactEvidence([{source:"product_costs",period:null,missing:[],
      item:{id:"latte",name:"Latte",priceCents:850}}]);
    expect(checkNumbers("Latte costs $6.","",[],"en",
      [...old,...current]).map(v=>v.text)).toEqual(["$6"]);
    expect(checkNumbers("Latte costs $8.50.","",[],"en",
      [...old,...current])).toEqual([]);
    expect(checkNumbers("Latte costs $6.","",
      [{source:"product_costs",period:null,missing:[],
        item:{id:"latte",name:"Latte",priceCents:850}}],"en",old)
      .map(v=>v.text)).toEqual(["$6"]);
  });
  it("invalidates now-unknown recipe costs without treating a read error as a refresh",()=>{
    const before=compactEvidence([{source:"product_costs",period:null,missing:[],
      item:{id:"latte",name:"Latte",priceCents:850,
        recipeCostCents:125,ingredientsCentsToday:125}}]);
    const unknown=compactEvidence([{source:"product_costs",period:null,
      missing:["ingredientCostUnavailable"],
      item:{id:"latte",name:"Latte",priceCents:850,
        recipeCostCents:null,ingredientsCentsToday:null}}]);
    expect(unknown[0].invalidatedKeys).toContain("item:latte/recipeCostCents");
    expect(checkNumbers("Ingredients cost $1.25.","",[],"en",
      [...before,...unknown]).map(v=>v.text)).toEqual(["$1.25"]);
    const error=compactEvidence([{source:"product_costs",period:null,
      missing:["sourceUnavailable"]}]);
    expect(checkNumbers("Ingredients cost $1.25.","",[],"en",
      [...before,...error])).toEqual([]);
  });
  it("checks the direction of menu comparisons before matching any raw price",()=>{
    const menu={source:"menu_items",period:null,missing:[],items:[
      {id:"latte",name:"Latte",priceCents:850},
      {id:"mocha",name:"Mocha",priceCents:600},
      {id:"tea",name:"Tea",priceCents:250}]};
    expect(checkNumbers("Mocha is $2.50 more than Latte.","",[menu],"en")
      .map(v=>v.text)).toEqual(["$2.50"]);
    expect(checkNumbers("Latte is $2.50 more than Mocha.","",[menu],"en"))
      .toEqual([]);
    expect(checkNumbers("Latte is $2.50 less than Mocha.","",[menu],"en")
      .map(v=>v.text)).toEqual(["$2.50"]);
  });
  it("validates currency-less prices against the named product",()=>{
    const menu={source:"menu_items",period:null,missing:[],items:[
      {id:"latte",name:"Latte",priceCents:850},
      {id:"mocha",name:"Mocha",priceCents:600}]};
    expect(checkNumbers("Latte costs 6.","",[menu],"en")
      .map(v=>v.text)).toEqual(["6"]);
    expect(checkNumbers("Latte costs 8.50.","",[menu],"en")).toEqual([]);
    expect(checkNumbers("Mocha costs 6.","",[menu],"en")).toEqual([]);
  });
  it("authorizes all source-backed current labor values beyond 100 historic entries",()=>{
    const earlier=compactEvidence([{source:"labor_and_attendance",
      period:{from:"2026-09-01",to:"2026-09-30"},missing:[],
      laborDays:Array.from({length:30},(_,i)=>({
        date:"2026-09-"+String(i+1).padStart(2,"0"),
        wagesCents:100+i,staffTaxCents:100,loadedStaffCostCents:200+i}))}],Infinity);
    const current={source:"labor_and_attendance",
      period:{from:"2026-10-01",to:"2026-10-22"},missing:[],
      laborDays:Array.from({length:22},(_,i)=>({
        date:"2026-10-"+String(i+1).padStart(2,"0"),
        wagesCents:1000+i,staffTaxCents:250,loadedStaffCostCents:1250+i}))};
    expect(checkNumbers("Staff tax is $2.50.","",[current],"en",earlier)).toEqual([]);
  });
  it("respects Arabic evening meridiems when checking claimed closing time",()=>{
    const morning={source:"locations.open_hours",period:null,missing:[],
      hours:{mon:[["01:00","05:00"]]}};
    const evening={source:"locations.open_hours",period:null,missing:[],
      hours:{mon:[["08:00","17:00"]]}};
    const claim="نغلق الساعة ٥:٠٠ مساءً يوم الاثنين.";
    expect(checkNumbers(claim,"",[morning],"ar").length).toBeGreaterThan(0);
    expect(checkNumbers(claim,"",[evening],"ar")).toEqual([]);
  });
});


describe("Codex: product identity, dated facts and partial schedule trust boundaries",()=>{
  it("reconciles an observed pricing-engine current price without inventing a name",()=>{
    const old=compactEvidence([{source:"menu_items",period:null,missing:[],
      items:[{id:"latte",name:"Latte",priceCents:600}]}]);
    const refreshed=compactEvidence([{source:"pricing_engine",period:null,missing:[],
      itemId:"latte",currentPriceCents:850,recommendedPriceCents:1000}]);
    expect(checkNumbers("Latte costs $6.","",[],"en",[...old,...refreshed])
      .map(v=>v.text)).toEqual(["$6"]);
    expect(checkNumbers("Latte costs $8.50.","",[],"en",[...old,...refreshed])).toEqual([]);
    expect(checkNumbers("Latte costs $10.","",[],"en",[...old,...refreshed])
      .map(v=>v.text)).toEqual(["$10"]);
  });
  it("selects the longest complete product name in direct-price and comparison claims",()=>{
    const menu={source:"menu_items",period:null,missing:[],items:[
      {id:"latte",name:"Latte",priceCents:600},
      {id:"iced-latte",name:"Iced Latte",priceCents:850},
      {id:"mocha",name:"Mocha",priceCents:350}]};
    expect(checkNumbers("Iced Latte costs $6.","",[menu],"en")
      .map(v=>v.text)).toEqual(["$6"]);
    expect(checkNumbers("Iced Latte costs $8.50.","",[menu],"en")).toEqual([]);
    expect(checkNumbers("Iced Latte is $5 more than Mocha.","",[menu],"en")).toEqual([]);
    expect(checkNumbers("Iced Latte is $2.50 more than Mocha.","",[menu],"en")
      .map(v=>v.text)).toEqual(["$2.50"]);
  });
  it("retains collection-length invalidations independently of stored numbers",()=>{
    const before=compactEvidence([{source:"menu_items",period:null,missing:[],
      items:Array.from({length:5},(_,i)=>({id:"old-"+i,name:"Old "+i,priceCents:300+i}))}]);
    const current=compactEvidence([
      {source:"menu_items",period:null,missing:[],
        items:[{id:"latte",name:"Latte",priceCents:850},
          {id:"mocha",name:"Mocha",priceCents:600}]},
      {source:"labor_and_attendance",period:null,missing:[],
        laborDays:Array.from({length:31},(_,i)=>({
          date:"2026-10-"+String(i+1).padStart(2,"0"),
          wagesCents:900+i,staffTaxCents:150,loadedStaffCostCents:1050+i}))},
      {source:"product_costs",period:null,missing:[],
        item:{id:"latte",name:"Latte",priceCents:850,recipeCostCents:120}},
      {source:"recurring_bills",period:null,missing:[],monthlyEquivalentCents:9000}
    ]);
    expect(current[0].invalidatedKeys).toContain("itemsLength");
    expect(checkNumbers("There are 5 menu items.","",[],"en",
      [...before,...current]).map(v=>v.text)).toEqual(["5"]);
    expect(checkNumbers("There are 2 menu items.","",[],"en",
      [...before,...current])).toEqual([]);
  });
  it("never applies one day's sales amount to another date",()=>{
    const yesterday={source:"daily_rollups",
      period:{from:"2026-10-21",to:"2026-10-21"},missing:[],
      netSalesCents:10000,days:[{date:"2026-10-21",netSalesCents:10000}]};
    const today={source:"daily_rollups",
      period:{from:"2026-10-22",to:"2026-10-22"},missing:[],
      netSalesCents:20000,days:[{date:"2026-10-22",netSalesCents:20000}]};
    const prior=compactEvidence([yesterday]);
    expect(checkNumbers("Sales on 2026-10-22 were $100.","",[today],"en",prior)
      .map(v=>v.text)).toEqual(["$100"]);
    expect(checkNumbers("Sales on 2026-10-22 were $200.","",[today],"en",prior)).toEqual([]);
    expect(checkNumbers("Sales on 2026-10-21 were $100.","",[today],"en",prior)).toEqual([]);
    expect(checkNumbers("Sales on 2026-10-22 were $100.","",[],"en",
      [...prior,...compactEvidence([today])]).map(v=>v.text)).toEqual(["$100"]);
  });
  it("binds every localized staff name to its corresponding clock",()=>{
    const schedule={source:"recurring_schedule",
      period:{from:"2026-11-02",to:"2026-11-08"},missing:[],
      shifts:[{displayName:"Ada",dayOfWeek:1,startTime:"08:00",
        endTime:"16:00",effectiveFrom:"2026-11-02",effectiveTo:null}]};
    const spanish="El turno de Ada empieza a las 8:00 y el turno de Bob termina a las 16:00 el lunes.";
    expect(checkNumbers(spanish,"",[schedule],"es").length).toBeGreaterThan(0);
    expect(checkNumbers("El turno de Ada empieza a las 8:00 el lunes.",
      "",[schedule],"es")).toEqual([]);
  });
  it("shares a trailing weekday with both endpoints of the same staff shift",()=>{
    const schedule={source:"recurring_schedule",
      period:{from:"2026-11-02",to:"2026-11-08"},missing:[],
      shifts:[{displayName:"Ada",dayOfWeek:1,startTime:"08:00",
        endTime:"16:00",effectiveFrom:"2026-11-02",effectiveTo:null}]};
    const wrong="Ada’s shift starts at 8:00 AM and her shift ends at 4:00 PM on Tuesday.";
    expect(checkNumbers(wrong,"",[schedule],"en").map(v=>v.text))
      .toEqual(["8:00 AM","4:00 PM"]);
    const good="Ada’s shift starts at 8:00 AM and her shift ends at 4:00 PM on Monday.";
    expect(checkNumbers(good,"",[schedule],"en")).toEqual([]);
  });
  it("retains omitted shift facts across truncated, non-exhaustive refreshed reads",()=>{
    const old=compactEvidence([{source:"recurring_schedule",
      period:{from:"2026-11-02",to:"2026-11-08"},missing:[],
      shifts:[{displayName:"Ada",dayOfWeek:1,startTime:"08:00",
        endTime:"16:00",effectiveFrom:"2026-11-02",effectiveTo:null}]}]);
    const partial=compactEvidence([{source:"recurring_schedule",
      period:{from:"2026-11-02",to:"2026-11-08"},
      missing:["scheduleResultTruncated"],
      shifts:[{displayName:"Bob",dayOfWeek:1,startTime:"09:00",
        endTime:"17:00",effectiveFrom:"2026-11-02",effectiveTo:null}]}]);
    expect(partial[0].timeScope).toEqual({
      kind:"schedule",from:"2026-11-02",to:"2026-11-08",exhaustive:false});
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday.",
      "",[],"en",[...old,...partial])).toEqual([]);
    expect(checkNumbers("Bob’s shift starts at 9:00 AM on Monday.",
      "",[],"en",[...old,...partial])).toEqual([]);
    const complete=compactEvidence([{source:"recurring_schedule",
      period:{from:"2026-11-02",to:"2026-11-08"},missing:[],
      shifts:[{displayName:"Bob",dayOfWeek:1,startTime:"09:00",
        endTime:"17:00",effectiveFrom:"2026-11-02",effectiveTo:null}]}]);
    expect(checkNumbers("Ada’s shift starts at 8:00 AM on Monday.",
      "",[],"en",[...old,...complete]).length).toBeGreaterThan(0);
  });
});


describe("follow-up: owner speech, bounded totals and proposed durations",()=>{
 const menu={source:"menu_items",period:null,missing:[],items:[
   {id:"a",name:"Latte",priceCents:550},{id:"b",name:"Mocha",priceCents:600}]};
 it("accepts owner-provided English monetary words",()=>{
   expect(checkNumbers("The owner price is $8.50.","Our price is eight point five dollars.",[],"en")).toEqual([]);
   expect(checkNumbers("The owner price is $5.50.","Set price to five fifty.",[],"en")).toEqual([]);
   expect(checkNumbers("The owner price is $8.50.","Price is eight dollars fifty.",[],"en")).toEqual([]);
   expect(checkNumbers("The owner price is $9.50.","Price is eight dollars fifty.",[],"en").map(x=>x.text)).toEqual(["$9.50"]);
 });
 it("accepts owner monetary words in Spanish and Arabic",()=>{
   expect(checkNumbers("El precio es $8.50.","El precio es ocho coma cinco dólares.",[],"es")).toEqual([]);
   expect(checkNumbers("El precio es $5.50.","El precio es cinco con cincuenta.",[],"es")).toEqual([]);
   expect(checkNumbers("السعر $8.50","السعر ثمانية فاصلة خمسة دولار",[],"ar")).toEqual([]);
   expect(checkNumbers("السعر $5.50","السعر خمسة دولارات وخمسون سنتا",[],"ar")).toEqual([]);
 });
 it("keeps spoken counts separate from owner money",()=>{
   expect(checkNumbers("You sold 8 drinks.","We sold eight drinks.",[],"en")).toEqual([]);
   expect(checkNumbers("You sold 8 drinks.","Vendimos ocho bebidas.",[],"es")).toEqual([]);
   expect(checkNumbers("Your profit is $8.","We sold eight drinks.",[],"en").map(x=>x.text)).toEqual(["$8"]);
   expect(checkNumbers("Margin is 8.5.","Margin is eight point five.",[],"en")).toEqual([]);
 });
 it("accepts explicit two and three operand money totals but not wrong totals",()=>{
   expect(checkNumbers("$5.50 and $6.00, together $11.50.","",[menu],"en")).toEqual([]);
   expect(checkNumbers("$5.50 and $6.00, together $12.","",[menu],"en").map(x=>x.text)).toEqual(["$12"]);
   const three={source:"expenses",period:null,missing:[],aCents:250,bCents:300,cCents:400};
   expect(checkNumbers("$2.50, $3.00 and $4.00, total $9.50.","",[three],"en")).toEqual([]);
   expect(checkNumbers("$2.50, $3.00 and $4.00, total $10.","",[three],"en").map(x=>x.text)).toEqual(["$10"]);
 });
 it("checks explicit money differences without unbounded arithmetic closure",()=>{
   expect(checkNumbers("$8.50 owner price vs $5.50 menu = $3 more.",
     "Owner price is $8.50.",[menu],"en")).toEqual([]);
   expect(checkNumbers("$8.50 owner price vs $5.50 menu = $4 more.",
     "Owner price is $8.50.",[menu],"en").map(x=>x.text)).toEqual(["$4"]);
   expect(checkNumbers("Profit is $11.50.", "",[menu],"en").map(x=>x.text)).toEqual(["$11.50"]);
 });
 it("ignores proposed durations, not business-duration assertions",()=>{
   expect(checkNumbers("Try this for 7 days, then test for 2 weeks.","",[],"en")).toEqual([]);
   expect(checkNumbers("Prueba esto por 7 días.","",[],"es")).toEqual([]);
   expect(checkNumbers("نجرب لمدة 7 أيام.","",[],"ar")).toEqual([]);
   expect(checkNumbers("Staff worked 7 days.","",[],"en")).toEqual([]);
 });
});


describe("review: no arithmetic or owner-speech laundering",()=>{
 it("rejects a fictional profit computed by adding costs and sales",()=>{
   const observed={source:"profitability",period:null,missing:[],
     netSalesCents:600,totalCostsCents:550,ownerProfitCents:50};
   expect(checkNumbers("$5.50 total costs and $6.00 sales. Profit is $11.50.",
     "",[observed],"en").map(x=>x.text)).toContain("$11.50");
 });
 it("treats spoken fifty as fifty cents, not five dollars",()=>{
   expect(checkNumbers("Price $5.50.","Price cinco con cincuenta.",[],"es")).toEqual([]);
   expect(checkNumbers("Price $8.50.","Price eight point fifty dollars.",[],"en")).toEqual([]);
   expect(checkNumbers("Price $10.","Price cinco con cincuenta.",[],"es").map(x=>x.text)).toEqual(["$10"]);
 });
 it("never reclassifies owner counts because a later sentence asks about profit",()=>{
   expect(checkNumbers("Profit is $8.","We sold eight drinks. What is our profit?",
     [],"en").map(x=>x.text)).toEqual(["$8"]);
 });
 it("only exempts proposals, not historical durations",()=>{
   expect(checkNumbers("Staff worked for 7 days.","",[],"en")).toEqual([]);
   expect(checkNumbers("Sales declined over 2 weeks.","",[],"en")).toEqual([]);
 });
});


describe("review: cents and compound amounts preserve owner intent",()=>{
 it("standalone cents cannot silently become whole dollars",()=>{
   expect(checkNumbers("$0.50","The price is fifty cents.",[],"en")).toEqual([]);
   expect(checkNumbers("$50","The price is fifty cents.",[],"en").map(x=>x.text)).toEqual(["$50"]);
   expect(checkNumbers("$0.50","El precio es cincuenta centavos.",[],"es")).toEqual([]);
   expect(checkNumbers("$50","El precio es cincuenta centavos.",[],"es").map(x=>x.text)).toEqual(["$50"]);
 });
 it("compound twenties and thirties are whole prices",()=>{
   expect(checkNumbers("$25","The price is twenty five dollars.",[],"en")).toEqual([]);
   expect(checkNumbers("$20","The price is twenty five dollars.",[],"en").map(x=>x.text)).toEqual(["$20"]);
   expect(checkNumbers("$35","El precio es treinta y cinco dólares.",[],"es")).toEqual([]);
   expect(checkNumbers("$30","El precio es treinta y cinco dólares.",[],"es").map(x=>x.text)).toEqual(["$30"]);
 });
});


describe("systemic review: signed typed speech and locally bound totals",()=>{
 it("treats positive and negative owner monetary speech as different evidence",()=>{
   expect(checkNumbers("Profit is -$50.","Our profit is minus fifty dollars.",[],"en")).toEqual([]);
   expect(checkNumbers("Profit is $50.","Our profit is minus fifty dollars.",[],"en")
     .map(x=>x.text)).toEqual(["$50"]);
   expect(checkNumbers("Profit is -$5.50.","Profit is minus five fifty.",[],"en")).toEqual([]);
   expect(checkNumbers("Profit is -$5.50.","Ganancia menos cinco con cincuenta dólares.",[],"es")).toEqual([]);
   expect(checkNumbers("Profit is $50.","Ganancia menos cincuenta dólares.",[],"es")
     .map(x=>x.text)).toEqual(["$50"]);
   expect(checkNumbers("الربح -$50","الربح سالب خمسون دولار",[],"ar")).toEqual([]);
   expect(checkNumbers("الربح $50","الربح سالب خمسون دولار",[],"ar")
     .map(x=>x.text)).toEqual(["$50"]);
 });
 it("does not extract fictitious smaller values from unsupported hundreds",()=>{
   expect(checkNumbers("Price is $50.","Price is one hundred and fifty dollars.",[],"en")
     .map(x=>x.text)).toEqual(["$50"]);
   expect(checkNumbers("Price is $1.","Price is one hundred and fifty dollars.",[],"en")
     .map(x=>x.text)).toEqual(["$1"]);
 });
 it("keeps percentage, number and money words in separate units",()=>{
   expect(checkNumbers("Margin 8.5%","Margin eight point five percent",[],"en")).toEqual([]);
   expect(checkNumbers("Margin 8.5%","Margin eight point five",[],"en")
     .map(x=>x.text)).toEqual(["8.5%"]);
   expect(checkNumbers("We sold 8 drinks.","We sold eight drinks.",[],"en")).toEqual([]);
   expect(checkNumbers("Profit is $8.","We sold eight drinks. What is our profit?",[],"en")
     .map(x=>x.text)).toEqual(["$8"]);
 });
 it("rejects wrong arithmetic even when the wrong result is another observed value",()=>{
   const prices={source:"menu_items",period:null,missing:[],
     items:[{id:"a",name:"Latte",priceCents:550},
       {id:"b",name:"Mocha",priceCents:600},
       {id:"c",name:"Tea",priceCents:1200}]};
   expect(checkNumbers("$5.50 and $6.00, together $11.50.","",[prices],"en")).toEqual([]);
   expect(checkNumbers("$5.50 and $6.00, together $12.","",[prices],"en")
     .map(x=>x.text)).toEqual(["$12"]);
 });
});


describe("spoken grammar: compound order and quantity boundaries",()=>{
 it("parses Arabic units-before-tens without leaking component amounts",()=>{
   expect(checkNumbers("$55","السعر خمسة وخمسون دولار",[],"ar")).toEqual([]);
   expect(checkNumbers("$5","السعر خمسة وخمسون دولار",[],"ar")
     .map(x=>x.text)).toEqual(["$5"]);
   expect(checkNumbers("$50","السعر خمسة وخمسون دولار",[],"ar")
     .map(x=>x.text)).toEqual(["$50"]);
 });
 it("does not treat item quantities as prices when money follows in a sentence",()=>{
   expect(checkNumbers("Price is $5","We sold five lattes for ten dollars",[],"en")
     .map(x=>x.text)).toEqual(["$5"]);
   expect(checkNumbers("We sold 5 lattes","We sold five lattes for ten dollars",[],"en")).toEqual([]);
 });
});


describe("review: expression and explicit-unit boundaries",()=>{
 it("does not reinterpret exactly five cents as fifty cents",()=>{
   expect(checkNumbers("Price is $5.05.","Price is five dollars and five cents.",[],"en")).toEqual([]);
   expect(checkNumbers("Price is $5.50.","Price is five dollars and five cents.",[],"en")
     .map(x=>x.text)).toEqual(["$5.50"]);
   expect(checkNumbers("El precio es $5.05.","El precio es cinco dólares y cinco centavos.",[],"es")).toEqual([]);
 });
 it("never combines a spoken amount across a period or comma",()=>{
   const owner="The price is twenty. Five dollars was the old price.";
   expect(checkNumbers("The new price is $20.","The price is twenty.",[],"en")).toEqual([]);
   expect(checkNumbers("The new price is $25.",owner,[],"en")
     .map(x=>x.text)).toEqual(["$25"]);
   expect(checkNumbers("The new price is $5.",owner,[],"en")).toEqual([]);
   expect(checkNumbers("$35","El precio es treinta. Y cinco dólares antes.",[],"es")
     .map(x=>x.text)).toEqual(["$35"]);
 });
});


describe("review: no partial Arabic teens or mixed-dollar cents",()=>{
 it("parses the full Arabic teen expression, never an embedded five-dollar value",()=>{
   expect(checkNumbers("$15","السعر خمسة عشر دولار",[],"ar")).toEqual([]);
   expect(checkNumbers("$5","السعر خمسة عشر دولار",[],"ar").map(x=>x.text)).toEqual(["$5"]);
   expect(checkNumbers("$15","السعر خمسة عشرة دولار",[],"ar")).toEqual([]);
 });
 it("keeps two explicit dollar-denominated numbers separate",()=>{
   const owner="The prices are five dollars and ten dollars.";
   expect(checkNumbers("$5",owner,[],"en")).toEqual([]);
   expect(checkNumbers("$10",owner,[],"en")).toEqual([]);
   expect(checkNumbers("$5.10",owner,[],"en").map(x=>x.text)).toEqual(["$5.10"]);
   expect(checkNumbers("$5.10","The price is five dollars and ten cents.",[],"en")).toEqual([]);
 });
});


describe("derived-value scoping is language-agnostic",()=>{
 const numbers={source:"profitability",period:null,missing:[],
   netSalesCents:600,totalCostsCents:550,ownerProfitCents:50};
 it("does not invent a new KPI after an English sentence boundary",()=>{
   expect(checkNumbers("$5.50 costs and $6.00 sales. Profit is $11.50",
     "",[numbers],"en").map(x=>x.text)).toContain("$11.50");
 });
 it("does not invent Spanish or Arabic profit from unrelated amounts",()=>{
   expect(checkNumbers("$5.50 costos y $6.00 ventas. ganancia $11.50",
     "",[numbers],"es").map(x=>x.text)).toContain("$11.50");
   expect(checkNumbers("$5.50 التكاليف و $6.00 المبيعات. الربح $11.50",
     "",[numbers],"ar").map(x=>x.text)).toContain("$11.50");
 });
});

describe("tool KPIs remain authoritative despite nearby arithmetic",()=>{
 const result={source:"profitability",period:null,missing:[],
   netSalesCents:600,totalCostsCents:550,ownerProfitCents:50};
 it("allows explicit verified profit and refuses unsupported profits",()=>{
   expect(checkNumbers("$6.00 sales minus $5.50 costs, profit $0.50.","",[result],"en")).toEqual([]);
   expect(checkNumbers("$6.00 sales minus $5.50 costs, profit $11.50.","",[result],"en")
     .map(x=>x.text)).toContain("$11.50");
 });
});


describe("CI and Codex: closed money expressions and decimal digits",()=>{
  it("consumes two spoken fractional digits as a single cent value",()=>{
    expect(checkNumbers("Price is $8.25.","Price is eight point two five dollars.",[],"en")).toEqual([]);
    expect(checkNumbers("Price is $8.20.","Price is eight point two five dollars.",[],"en")
      .map(v=>v.text)).toEqual(["$8.20"]);
    expect(checkNumbers("Price is $8.05.","Price is eight point zero five dollars.",[],"en")).toEqual([]);
    expect(checkNumbers("Price is $8.50.","Price is eight point fifty dollars.",[],"en")).toEqual([]);
    expect(checkNumbers("Precio $8.25.","Precio ocho coma dos cinco dólares.",[],"es")).toEqual([]);
    expect(checkNumbers("السعر $8.25","السعر ثمانية فاصلة اثنين خمسة دولار",[],"ar")).toEqual([]);
  });
  it("does not inherit a previous total marker when validating a later business fact",()=>{
    const tool={source:"profitability",period:null,missing:[],
      netSalesCents:600,totalCostsCents:550,tipCents:100};
    expect(checkNumbers("$6.00 and $5.50, total $11.50, tip $1.00.","",[tool],"en")).toEqual([]);
    expect(checkNumbers("$6.00 and $5.50, total $12, tip $1.00.","",[tool],"en")
      .map(v=>v.text)).toEqual(["$12"]);
    expect(checkNumbers("$6.00 and $5.50, total $11.50, tip $2.00.","",[tool],"en")
      .map(v=>v.text)).toEqual(["$2.00"]);
  });
});


describe("Codex: expression-local operands and mixed operators",()=>{
  const observed={source:"profitability",period:null,missing:[],
    firstCents:1000,secondCents:300,thirdCents:200};
  it("uses each operator instead of subtracting every later amount",()=>{
    expect(checkNumbers("$10 minus $3 plus $2 = $9.","",[observed],"en")).toEqual([]);
    expect(checkNumbers("$10 minus $3 plus $2 = $5.","",[observed],"en")
      .map(x=>x.text)).toEqual(["$5"]);
    expect(checkNumbers("$10 plus $3 minus $2 = $11.","",[observed],"en")).toEqual([]);
    expect(checkNumbers("$10 plus $3 minus $2 = $9.","",[observed],"en")
      .map(x=>x.text)).toEqual(["$9"]);
  });
  it("does not pull an unrelated budget into a price total",()=>{
    const values={source:"profitability",period:null,missing:[],
      budgetCents:1000,firstPriceCents:600,secondPriceCents:550,
      combinedPriceCents:1150};
    expect(checkNumbers("Our budget is $10, prices are $6 and $5.50, total $11.50.","",
      [values],"en")).toEqual([]);
    expect(checkNumbers("Our budget is $10, prices are $6 and $5.50, total $12.","",
      [values],"en").map(x=>x.text)).toEqual(["$12"]);
  });
  it("does not certify the sum of distinct KPIs as a business result",()=>{
    const metrics={source:"profitability",period:null,missing:[],
      netSalesCents:600,totalCostsCents:550,ownerProfitCents:50};
    expect(checkNumbers("$5.50 costs and $6.00 sales, together $11.50.","",
      [metrics],"en").map(x=>x.text)).toEqual(["$11.50"]);
    expect(checkNumbers("$6.00 sales minus $5.50 costs, profit $0.50.","",
      [metrics],"en")).toEqual([]);
  });
});


describe("Codex: explicit result boundary and symbolic cents",()=>{
 const observed={source:"profitability",period:null,missing:[],
   tenCents:1000,threeCents:300,twoCents:200,
   sixCents:600,fiveFiftyCents:550,unrelatedCents:1200};
 it("does not mistake an operand's minus sign for a result marker",()=>{
   expect(checkNumbers("$10 plus $3 minus $2 = $11.","",[observed],"en")).toEqual([]);
   expect(checkNumbers("$10 plus $3 minus $2 = $7.","",[observed],"en")
     .map(v=>v.text)).toEqual(["$7"]);
   expect(checkNumbers("$10 minus $3 plus $2 = $9.","",[observed],"en")).toEqual([]);
 });
 it("verifies symbolic addition even when plus is absorbed into the currency token",()=>{
   expect(checkNumbers("$6 + $5.50 = $11.50.","",[observed],"en")).toEqual([]);
   expect(checkNumbers("$6 + $5.50 = $12.","",[observed],"en")
     .map(v=>v.text)).toEqual(["$12"]);
   expect(checkNumbers("$6 +$5.50 = $11.50.","",[observed],"en")).toEqual([]);
 });
 it("understands symbolic subtraction without inventing negative evidence",()=>{
   expect(checkNumbers("$6 - $5.50 = $0.50.","",[observed],"en")).toEqual([]);
   expect(checkNumbers("$6 - $5.50 = $11.50.","",[observed],"en")
     .map(v=>v.text)).toEqual(["$11.50"]);
 });
});

describe("numeric source classifications",()=>{
  it("marks the owner figure blue and calculation estimate amber, but not recorded fixed costs",()=>{
    const statement="net sales Oct 1-22 = $11,000, ingredients+packaging 20%";
    const reply="Sales $11,000; variable rate 20%; fixed costs $707.24; break-even $884.05.";
    const result={source:"break_even",period:null,missing:[],
      estimate:{dailyCostsToCoverCents:70724},
      ownerNetSalesCents:1100000,ownerIngredientPackagingBps:2000,
      ownerComparison:{dailyBreakEvenSalesCents:88405},
      numberEstimates:[{value:88405,unit:"cents",detail:"breakEvenSales"}]};
    const annotations=numberProvenance(reply,statement,[result],"en");
    expect(annotations.find(v=>v.text==="$11,000")?.source).toBe("owner");
    expect(annotations.find(v=>v.text==="20%")?.source).toBe("owner");
    expect(annotations.find(v=>v.text==="$884.05")?.source).toBe("estimate");
    expect(annotations.find(v=>v.text==="$707.24")).toBeUndefined();
  });
  it("does not mark date ranges, day counts, or clock times; still checks nearby unsupported orders",()=>{
    const reply="Oct 1-22: 9 orders, 8 days; at 8am.";
    const v=numberProvenance(reply,"8 days",[],"en");
    expect(v.map(x=>x.text)).toContain("9");
    expect(v.map(x=>x.text)).not.toContain("1");
    expect(v.map(x=>x.text)).not.toContain("22");
    expect(v.map(x=>x.text)).not.toContain("8");
  });
});

describe("Codex P1 source-specific checks",()=>{
  it("keeps unsupported opening hours but ignores incidental clock tokens",()=>{
    const business="We open Monday at 8:00 AM.";
    const flagged=checkNumbers(business,"",[],"en");
    expect(flagged.length).toBeGreaterThan(0);
    const marked=numberProvenance(business,"",[],"en");
    expect(marked.some(x=>x.source==="unchecked"&&flagged.some(f=>f.start===x.start&&f.end===x.end))).toBe(true);
    expect(numberProvenance("We received 9 orders at 8:00 AM.","",[],"en")
      .some(x=>x.text.includes("8:00"))).toBe(false);
  });
  it("does not mislabel another product's price with the owner's provenance",()=>{
    const owner="Latte costs $5.";
    const evidence=[{source:"menu_items",period:null,missing:[],items:[
      {id:"1",name:"Latte",priceCents:500},{id:"2",name:"Mocha",priceCents:600}
    ]}];
    const reply="Mocha costs $5.";
    expect(checkNumbers(reply,owner,evidence,"en").map(x=>x.text)).toContain("$5");
    expect(numberProvenance(reply,owner,evidence,"en").find(x=>x.text==="$5")?.source).toBe("unchecked");
  });
  it("does not turn dated sales mismatch into owner provenance",()=>{
    const owner="Sales on October 1 were $5.";
    const reply="Sales on October 2 were $5.";
    const flagged=checkNumbers(reply,owner,[],"en");
    expect(flagged.length).toBeGreaterThan(0);
    const provenance=numberProvenance(reply,owner,[],"en");
    expect(provenance.some(x=>x.source==="unchecked"&&flagged.some(f=>f.start===x.start&&f.end===x.end))).toBe(true);
  });
});

describe("no checker warning may disappear during provenance decoration",()=>{
  it("exempts duration tokens without hiding adjacent unsupported counts",()=>{
    const reply="We\'ve had 90 days of labor data, with 99 sales.";
    expect(checkNumbers(reply,"",[],"en").map(v=>v.text)).toEqual(["99"]);
    expect(numberProvenance(reply,"",[],"en").map(v=>v.text)).toEqual(["99"]);
  });
  const cases=[
    {text:"Mocha costs $5.",owner:"Latte costs $5.",results:[
      {source:"menu_items",period:null,missing:[],items:[{id:"a",name:"Latte",priceCents:500},
        {id:"b",name:"Mocha",priceCents:600}]}],locale:"en" as const},
    {text:"Sales on October 2 were $5.",owner:"Sales on October 1 were $5.",results:[],locale:"en" as const},
  ];
  for(const testCase of cases){
    it("retains every unsupported numeric span for "+testCase.text,()=>{
      const checked=checkNumbers(testCase.text,testCase.owner,testCase.results,testCase.locale);
      const marked=numberProvenance(testCase.text,testCase.owner,testCase.results,testCase.locale);
      expect(checked.length).toBeGreaterThan(0);
      for(const claim of checked){
        const annotation=marked.find(v=>v.start===claim.start&&v.source==="unchecked");
        expect(annotation).toBeDefined();
        expect(annotation?.end).toBeGreaterThanOrEqual(claim.end);
      }
    });
  }
  it("keeps numeric day units attached but does not decorate owner-backed or proposed durations",()=>{
    const claim="Payroll is recorded for 90 days.";
    const annotated=numberProvenance(claim,"",[],"en");
    expect(annotated.find(v=>v.text==="90 days")).toBeUndefined();
    expect(numberProvenance("There are 8 days.","There are 8 days.",[],"en")
      .some(v=>v.text==="8 days")).toBe(false);
    expect(numberProvenance("I suggest trying it for 8 days.","",[],"en")
      .some(v=>v.text==="8 days")).toBe(false);
  });
});

describe("calendar range exemptions are owned by the checker",()=>{
 it("does not reject Oct 1-22 while still rejecting an adjacent unsupported count",()=>{
   const reply="Oct 1-22: we recorded 9 orders.";
   const rejected=checkNumbers(reply,"",[],"en");
   expect(rejected.map(v=>v.text)).toEqual(["9"]);
   const annotated=numberProvenance(reply,"",[],"en");
   expect(annotated.map(v=>v.text)).toEqual(["9"]);
   expect(annotated[0].source).toBe("unchecked");
 });
 it("does not mistake a Spanish month range or Arabic month range for count evidence",()=>{
   const cases=[
     ["Del 1-22 de octubre se registraron 9 pedidos.","es"],
     ["من ١-٢٢ أكتوبر سجلنا ٩ طلبات.","ar"],
   ] as const;
   for(const [text,locale] of cases){
     const annotated=numberProvenance(text,"",[],locale);
     expect(annotated.map(v=>v.text)).toEqual(locale==="es"?["9"]:["٩"]);
   }
 });
});

describe("saved estimate provenance",()=>{
  it("retains modeled break-even label and detail across turns",()=>{
    const result={source:"break_even",period:null,missing:[],
      ownerComparison:{dailyBreakEvenSalesCents:12988,dailyShortfallCents:2988},
      numberEstimates:[
        {value:12988,unit:"cents",detail:"breakEvenSales"},
        {value:2988,unit:"cents",detail:"salesGap"},
      ]};
    const evidence=compactEvidence([result]);
    expect(evidence.flatMap(e=>e.values)).toEqual(expect.arrayContaining([
      expect.objectContaining({value:12988,provenance:"estimate",detail:"breakEvenSales"}),
      expect.objectContaining({value:2988,provenance:"estimate",detail:"salesGap"}),
    ]));
    const next=numberProvenance("Break-even $129.88 and gap $29.88.","",[],"en",evidence);
    expect(next).toEqual(expect.arrayContaining([
      expect.objectContaining({text:"$129.88",source:"estimate",detail:"breakEvenSales"}),
      expect.objectContaining({text:"$29.88",source:"estimate",detail:"salesGap"}),
    ]));
  });
  it("does not retain the old estimate mark after an updated cost calculation",()=>{
    const old=compactEvidence([{source:"break_even",period:null,missing:[],
      ownerComparison:{dailyBreakEvenSalesCents:12988},
      numberEstimates:[{value:12988,unit:"cents",detail:"breakEvenSales"}]}]);
    const updated={source:"break_even",period:null,missing:[],
      ownerComparison:{dailyBreakEvenSalesCents:15000},
      numberEstimates:[{value:15000,unit:"cents",detail:"breakEvenSales"}]};
    const a=numberProvenance("Break-even was $129.88; break-even is now $150.00.","",[updated],"en",old);
    expect(a.find(v=>v.text==="$129.88")?.source).not.toBe("estimate");
    expect(a.find(v=>v.text==="$150.00")?.source).toBe("estimate");
  });
});

describe("Codex adversarial provenance matrix: identity, history and amounts",()=>{
  it("uses local metric clauses when overhead precedes an amount-first break-even",()=>{
    const results=[{source:"break_even",period:null,missing:[],
      ownerComparison:{dailyFixedCostsCents:10000,dailyBreakEvenSalesCents:12988},
      numberEstimates:[
        {value:10000,unit:"cents",detail:"dailyOverhead"},
        {value:12988,unit:"cents",detail:"breakEvenSales"},
      ]}];
    for(const evidence of [[],compactEvidence(results)]){
      const current=evidence.length?[]:results;
      for(const reply of [
        "Daily overhead is $100, $129.88 is your break-even.",
        "Daily overhead is $100 and break-even is $129.88.",
        "Break-even is $129.88 and daily overhead is $100.",
      ]){
        expect(checkNumbers(reply,"",current,"en",evidence)).toEqual([]);
        const marked=numberProvenance(reply,"",current,"en",evidence);
        expect(marked).toHaveLength(2);
        for(const [amount,detail] of [
          ["$100","dailyOverhead"],["$129.88","breakEvenSales"],
        ] as const){
          expect(marked.find(m=>m.text===amount)).toMatchObject({source:"estimate",detail});
        }
      }
    }
  });
  it("keeps metric attribution when the estimate name follows the number",()=>{
    const model={source:"break_even",period:null,missing:[],
      ownerComparison:{dailyBreakEvenSalesCents:12988},
      numberEstimates:[{value:12988,unit:"cents",detail:"breakEvenSales"}]};
    const saved=compactEvidence([model]);
    const phrases=[
      ["$129.88 is your break-even.","en"],
      ["129.88 is your break-even.","en"],
      ["$129.88 equals your break-even.","en"],
      ["$129.88 son tus ventas de equilibrio.","es"],
      ["129,88 son tus ventas de equilibrio.","es"],
      ["$129.88 هي مبيعات التعادل.","ar"],
    ] as const;
    for(const [reply,locale] of phrases){
      for(const useSaved of [false,true]){
        const current=useSaved?[]:[model];
        const previous=useSaved?saved:[];
        expect(checkNumbers(reply,"",current,locale,previous)).toEqual([]);
        expect(numberProvenance(reply,"",current,locale,previous)).toEqual([
          expect.objectContaining({source:"estimate",detail:"breakEvenSales",start:0}),
        ]);
      }
    }
    const unrelated="Mocha costs $6. $129.88 is your break-even.";
    const prices=[{source:"menu_items",period:null,missing:[],items:[
      {id:"mocha",name:"Mocha",priceCents:600},
    ]}];
    const marks=numberProvenance(unrelated,"",[...prices,model],"en");
    expect(marks.filter(mark=>mark.source==="estimate")).toHaveLength(1);
    expect(marks[0]?.start).toBe(unrelated.indexOf("$129.88"));
  });

  it("does not resurrect estimates from an earlier call within the same agent turn",()=>{
    const earlier={source:"break_even",period:null,missing:[],
      ownerComparison:{dailyBreakEvenSalesCents:12988},
      numberEstimates:[{value:12988,unit:"cents",detail:"breakEvenSales"}]};
    const invalid={source:"break_even",period:null,missing:["invalidContributionMargin"],
      ownerComparison:{dailyFixedCostsCents:null,dailyBreakEvenSalesCents:null,dailyShortfallCents:null}};
    const reply="Break-even is $129.88.";
    expect(checkNumbers(reply,"",[earlier,invalid],"en").map(x=>x.text)).toContain("$129.88");
    expect(numberProvenance(reply,"",[earlier,invalid],"en").find(x=>x.text==="$129.88")?.source)
      .toBe("unchecked");
  });

  const estimate=(amount:number,detail:"breakEvenSales"|"salesGap"|"dailyOverhead")=>({
    value:amount,unit:"cents",detail,
  });
  it("does not label a supported product price as an unrelated break-even estimate",()=>{
    const results=[
      {source:"menu_items",period:null,missing:[],items:[{id:"m",name:"Mocha",priceCents:600}]},
      {source:"break_even",period:null,missing:[],
        ownerComparison:{dailyBreakEvenSalesCents:600},
        numberEstimates:[estimate(600,"breakEvenSales")]},
    ];
    const reply="Mocha costs $6. Break-even is $6.";
    expect(checkNumbers(reply,"",results,"en")).toEqual([]);
    const marks=numberProvenance(reply,"",results,"en");
    expect(marks.filter(m=>m.source==="estimate")).toEqual([
      expect.objectContaining({text:"$6",detail:"breakEvenSales",start:reply.lastIndexOf("$6")}),
    ]);
    expect(marks.some(m=>m.start===reply.indexOf("$6")&&m.source==="estimate")).toBe(false);
    const saved=compactEvidence(results);
    const followUp=numberProvenance(reply,"",[],"en",saved);
    expect(followUp.filter(m=>m.source==="estimate")).toHaveLength(1);
    expect(followUp[0]?.start).toBe(reply.lastIndexOf("$6"));
  });
  it("decorates a currency-less monetary break-even, never an ordinary drink count",()=>{
    const result={source:"break_even",period:null,missing:[],
      ownerComparison:{dailyBreakEvenSalesCents:12988},
      numberEstimates:[estimate(12988,"breakEvenSales")]};
    const text="Break-even sales are 129.88 per day.";
    expect(checkNumbers(text,"",[result],"en")).toEqual([]);
    expect(numberProvenance(text,"",[result],"en")).toEqual([
      expect.objectContaining({text:"129.88",source:"estimate",detail:"breakEvenSales"}),
    ]);
    const count="We sold 129.88 drinks.";
    expect(numberProvenance(count,"",[result],"en")
      .some(v=>v.source==="estimate")).toBe(false);
  });
  it("keeps estimated daily overhead labeled through persistence and removes it on refresh",()=>{
    const old={source:"break_even",period:null,missing:[],estimated:["expense:rent"],
      ownerComparison:{dailyFixedCostsCents:10000,dailyBreakEvenSalesCents:12500},
      numberEstimates:[estimate(10000,"dailyOverhead"),estimate(12500,"breakEvenSales")]};
    const saved=compactEvidence([old]);
    expect(saved.flatMap(e=>e.values)).toEqual(expect.arrayContaining([
      expect.objectContaining({key:"dailyFixedCostsCents",value:10000,
        provenance:"estimate",detail:"dailyOverhead"}),
    ]));
    for(const [locale,text] of [
      ["en","Daily overhead is $100."],
      ["es","Los gastos fijos diarios son $100."],
      ["ar","التكاليف الثابتة اليومية $100."],
    ] as const){
      expect(numberProvenance(text,"",[],locale,saved)).toEqual([
        expect.objectContaining({text:"$100",source:"estimate",detail:"dailyOverhead"}),
      ]);
    }
    const fresh={source:"break_even",period:null,missing:[],
      ownerComparison:{dailyFixedCostsCents:10000,dailyBreakEvenSalesCents:12500},
      numberEstimates:[estimate(12500,"breakEvenSales")]};
    expect(numberProvenance("Daily overhead $100.","",[fresh],"en",saved)
      .some(v=>v.source==="estimate")).toBe(false);
  });
  it("invalidates a previously saved model when a new contribution margin is impossible",()=>{
    const old={source:"break_even",period:null,missing:[],
      ownerComparison:{dailyFixedCostsCents:10000,dailyBreakEvenSalesCents:12988},
      numberEstimates:[estimate(12988,"breakEvenSales")]};
    const invalid={source:"break_even",period:null,missing:["invalidContributionMargin"],
      ownerComparison:{dailyFixedCostsCents:null,dailyBreakEvenSalesCents:null,dailyShortfallCents:null}};
    const saved=compactEvidence([old]);
    const invalidation=compactEvidence([invalid]);
    expect(invalidation.flatMap(e=>e.invalidatedKeys??[])).toContain("dailyBreakEvenSalesCents");
    const reply="Your break-even is $129.88.";
    expect(checkNumbers(reply,"",[invalid],"en",saved).map(v=>v.text)).toContain("$129.88");
    expect(numberProvenance(reply,"",[invalid],"en",saved).find(v=>v.text==="$129.88")?.source)
      .toBe("unchecked");
  });
});
