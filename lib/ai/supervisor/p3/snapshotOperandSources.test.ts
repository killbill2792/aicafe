import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {atomicP1SourceSchema} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import {extractAtomicSnapshot} from "./snapshotOperandSources";
import {projectP1Evidence} from "./operandProjection.server";
import {evaluateExpression,EXPRESSION_ID} from "./expression";
import {readers} from "@/lib/metrics/p1Catalog";
import type {ShadowEvidence} from "@/lib/ai/supervisor/p2/shadow.server";

const cafe="a12a12a1-1111-4111-8111-a12a12a12a12";
const other="b12b12b1-1111-4111-8111-b12b12b12b12";
const latte="c12c12c1-1111-4111-8111-c12c12c12c12";
const milk="d12d12d1-1111-4111-8111-d12d12d12d12";
const price="e12e12e1-1111-4111-8111-e12e12e12e12";
const sophie="f12f12f1-1111-4111-8111-f12f12f12f12";
const asOf="2026-10-15";
const sources={
  menu:[{id:latte,name:"Iced Latte",price_cents:525,is_active:true,category:"drink"}],
  ingredients:[{id:milk,name:"whole milk",base_unit:"ml"}],
  ingredientPrices:[{id:price,ingredient_id:milk,effective_from:"2026-10-14",
    cost_per_base_unit_micros:500000,source:"invoice"}],
  recipes:[{menu_item_id:latte,ingredient_id:milk,quantity:250}],
  employees:[{id:sophie,display_name:"Sophie",active:true,role:"barista",
    default_hourly_wage_cents:1800,wage_period:"hour",wage_amount_cents:1800}],
  dailyRollups:[],expenses:[],recurringCosts:[],imports:[],
} as const;
const truncated=Object.fromEntries(Object.keys(sources).map(k=>[k,false]));
const snapshot=(overrides:Record<string,unknown>={})=>
  atomicP1SourceSchema.parse({
    contract:"p1.authoritative_snapshot.v1",businessId:cafe,revision:"25",
    timezone:"America/Los_Angeles",currency:"USD",
    payroll:{rate:0.12,status:"confirmed",source:"owner_confirmed"},
    sources,truncated,coverage:"not_proven_by_revision",...overrides,
  });
const quality={level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]} as const;
function read(key:"menu.product_economics"|"labor.employee_wages"|"labor.payroll_burden",
  clause:string):ShadowEvidence{
  const purpose=key==="menu.product_economics"?"current_recipe_cost_review":
    key==="labor.employee_wages"?"authorized_owner_wage_review":
      "authorized_owner_employer_cost_review";
  const query={id:key,version:1,purpose,
    ...(key==="menu.product_economics"?{productId:latte}:{})};
  // This legacy observation is an independently fetched SELECTOR. Its
  // deliberately false numeric value must NEVER reach an atomic operand.
  const value=key==="menu.product_economics"?{
    id:latte,name:"Iced Latte",category:"drink",active:true,
    priceCents:999,prepSeconds:10,ingredientsCentsToday:900,hasRecipe:true,
    costStatus:"READY",quantitySoldLast28Days:5,
  }:key==="labor.employee_wages"?[{
    id:sophie,name:"Sophie",role:"barista",active:true,
    defaultHourlyWageCents:9999,wagePeriod:"hour",wageAmountCents:9999,
    wageKnown:true,wageProvenance:"recorded_positive",
  }]:{rateBasisPoints:9999,status:"confirmed",source:"owner"};
  return {clause,capabilityId:"p3."+key+".v1",status:"partial",reason:null,
    result:{id:key,version:1,query,unit:"typed_record",valueKind:"record",
      status:"partial",completeness:"partial",actuality:"actual",value,quality,
      provenance:{canonicalReaderId:readers[key],readerContractVersion:1,
        selectorContractId:key+".selector",selectorContractVersion:1,
        purpose,asOf,timezone:"America/Los_Angeles",sourceRevision:null},
      freshness:{asOf,capturedAt:null,stale:null}},
  };
}

describe("authoritative P3 source projection",()=>{
  it("COMPOSE-01: price, recipe cost, wages and burden derive ONLY from one epoch",()=>{
    const goal="Sell 25 more Iced Latte and Sophie works 45 extra paid minutes";
    const evidence=[
      read("menu.product_economics","Sell 25 more Iced Latte"),
      read("labor.employee_wages","Sophie works 45 extra paid minutes"),
      read("labor.payroll_burden","Sophie works 45 extra paid minutes"),
    ];
    const projection=projectP1Evidence(evidence,cafe,goal,null,[],snapshot());
    expect(projection.operands).toHaveLength(4);
    const fields=Object.fromEntries(projection.operands.map(o=>[o.sourceId+":"+o.handle.split(":").at(-1),o.value]));
    expect(fields["menu.product_economics:priceCents"]).toBe(525);
    expect(fields["menu.product_economics:ingredientsCentsToday"]).toBe(125);
    expect(fields["labor.employee_wages:defaultHourlyWageCents"]).toBe(1800);
    expect(fields["labor.payroll_burden:rateBasisPoints"]).toBe(1200);
    expect(projection.operands.every(o=>o.sourceRevision==="25"&&
      o.status==="partial"&&o.evidenceStatus==="unverified"&&
      o.missingInputs.includes("coverage_not_proven_by_revision")&&
      o.observedContentHash===null)).toBe(true);
    const h=(suffix:string)=>projection.operands.find(o=>o.handle.endsWith(suffix))!.handle;
    const result=evaluateExpression({
      capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",
      description:"Additional drink contribution after employer-loaded paid minutes",
      nodes:[
        {op:"source",handle:h(":priceCents")},
        {op:"source",handle:h(":ingredientsCentsToday")},{op:"subtract"},
        {op:"hypothetical",label:"additional drinks",quotedNumber:"25",value:25,unit:"item"},
        {op:"multiply"},
        {op:"source",handle:h(":defaultHourlyWageCents")},
        {op:"hypothetical",label:"extra paid minutes",quotedNumber:"45",value:45,unit:"minute"},
        {op:"multiply"},
        {op:"source",handle:h(":rateBasisPoints")},{op:"loaded_labor"},
        {op:"scenario_delta"},
      ],
    },{businessId:cafe,locationId:null,ownerMessage:goal,currency:"USD",
      operands:projection.operands,bindings:projection.bindings});
    expect(result).toMatchObject({status:"partial",value:8488,unit:"USD_cents",
      reason:"incomplete_evidence",executedEffects:0});
  });
  it("COMPOSE-03: correctly costs whole, oat and almond milk in US gallons",()=>{
    const oat="11111111-1111-4111-8111-111111111111";
    const almond="22222222-2222-4222-8222-222222222222";
    const priced=snapshot({sources:{...sources,
      ingredients:[...sources.ingredients,
        {id:oat,name:"oat milk",base_unit:"ml"},
        {id:almond,name:"almond milk",base_unit:"ml"}],
      ingredientPrices:[...sources.ingredientPrices,
        {id:"33333333-3333-4333-8333-333333333333",
          ingredient_id:oat,effective_from:"2026-10-15",
          cost_per_base_unit_micros:600000,source:"invoice"},
        {id:"44444444-4444-4444-8444-444444444444",
          ingredient_id:almond,effective_from:"2026-10-15",
          cost_per_base_unit_micros:700000,source:"invoice"}],
    }});
    const projected=extractAtomicSnapshot("menu.ingredients",priced,{},asOf)!;
    expect(projected.leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({name:"whole milk",value:1893,
        unit:"USD_cents_per_US_gallon"}),
      expect.objectContaining({name:"oat milk",value:2271}),
      expect.objectContaining({name:"almond milk",value:2650}),
    ]));
    expect(projected.missingInputs).toContain(
      "ingredient_price_freshness_and_option_mix_unproven");
    // Unrecorded customer choice counts, package prices and gram-to-volume
    // assumptions cannot be derived from this ingredient-only snapshot.
    const grams=snapshot({sources:{...sources,
      ingredients:[{...sources.ingredients[0],base_unit:"g"}]}});
    expect(extractAtomicSnapshot("menu.ingredients",grams,{},asOf)!.leaves)
      .toEqual([]);
  });
  it("COMPOSE-04: never invents a zero ingredient cost, a wage or a covered period",()=>{
    const absent=snapshot({sources:{...sources,ingredientPrices:[],
      employees:[{...sources.employees[0],default_hourly_wage_cents:null,
        wage_period:"month",wage_amount_cents:300000}]}});
    expect(extractAtomicSnapshot("menu.product_economics",absent,
      {productId:latte},asOf)?.leaves.map(x=>x.field))
      .toEqual(["priceCents"]);
    expect(extractAtomicSnapshot("labor.employee_wages",absent,{},asOf)?.leaves)
      .toHaveLength(0);
    expect(extractAtomicSnapshot("sales.daily",absent,
      {period:{from:"2026-10-14",to:"2026-10-15"}},asOf)?.leaves)
      .toHaveLength(0);
    const estimated=snapshot({payroll:{rate:0.12,status:"estimated",
      source:"system_estimate"}});
    expect(extractAtomicSnapshot("labor.payroll_burden",estimated,{},asOf))
      .toMatchObject({missingInputs:["estimated_employer_burden"]});
  });
  it("preserves exact cents through large offsetting daily values (Codex P2 regression)",()=>{
    const row=(date:string,sales:number)=>({
      business_date:date,net_sales_cents:sales,orders_count:0,
      drinks_count:0,ingredients_cents:0,staff_wages_cents:0,
      staff_tax_cents:0,card_fees_cents:0,sales_data_status:"actual",
      staff_tax_status:"actual",
    });
    const data=snapshot({sources:{...sources,dailyRollups:[
      row("2026-10-13",Number.MAX_SAFE_INTEGER),
      row("2026-10-14",2),
      row("2026-10-15",-Number.MAX_SAFE_INTEGER),
    ]}});
    const selected=extractAtomicSnapshot("sales.daily",data,{
      period:{from:"2026-10-13",to:"2026-10-15"}},asOf);
    expect(selected?.leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({field:"netSalesCents",value:2}),
    ]));
    expect(selected?.missingInputs).toContain(
      "pos_import_date_and_item_coverage_not_proven");
  });
  it("COMPOSE-04: card fee zeros and estimates remain unprojectable without status",()=>{
    const row={business_date:asOf,net_sales_cents:1000,orders_count:2,
      drinks_count:2,ingredients_cents:180,staff_wages_cents:300,
      staff_tax_cents:36,card_fees_cents:0,sales_data_status:"actual",
      staff_tax_status:"actual"} as const;
    const snap=snapshot({sources:{...sources,dailyRollups:[row]}});
    const projection=extractAtomicSnapshot("sales.daily",snap,
      {period:{from:asOf,to:asOf}},asOf)!;
    expect(projection.leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({field:"netSalesCents",value:1000}),

    ]));
    expect(projection.leaves.some(x=>x.field==="cardFeesCents"||
      x.field==="ingredientsCents")).toBe(false);
    expect(projection.missingInputs).toContain(
      "card_fee_status_unavailable_from_atomic_snapshot");
    expect(projection.missingInputs).toContain(
      "historical_ingredient_cost_coverage_not_proven");
    // A daily wage zero has no proof that attendance and payroll have been
    // completely imported; it must not become a real zero-cost operand.
    const labor=extractAtomicSnapshot("labor.daily_costs",snap,
      {period:{from:asOf,to:asOf}},asOf)!;
    expect(labor.leaves).toEqual([]);
    expect(labor.missingInputs).toContain(
      "labor_attendance_and_wage_coverage_not_proven");
  });
  it("COMPOSE-05: active Toast pilot never promotes unreviewed daily sales to actual",()=>{
    const day={business_date:asOf,net_sales_cents:9000,orders_count:5,
      drinks_count:5,ingredients_cents:0,staff_wages_cents:0,
      staff_tax_cents:0,card_fees_cents:0,sales_data_status:"actual",
      staff_tax_status:"estimated"} as const;
    const selected=snapshot({sources:{...sources,dailyRollups:[day]}});
    try{
      vi.stubEnv("TOAST_PILOT_IMPORT_ENABLED","true");
      const out=extractAtomicSnapshot("sales.daily",selected,
        {period:{from:asOf,to:asOf}},asOf);
      expect(out).toMatchObject({leaves:[],
        missingInputs:["toast_independent_sales_review_not_in_snapshot"]});
    }finally{vi.unstubAllEnvs();}
  });
  it("COMPOSE-04: unrelated old rollups truncated do not invalidate covered recent dates",()=>{
    const start=new Date("2026-10-15T12:00:00Z").getTime();
    const daily=Array.from({length:367},(_,i)=>({
      business_date:new Date(start-i*86400000).toISOString().slice(0,10),
      net_sales_cents:1000,orders_count:2,drinks_count:2,
      ingredients_cents:0,staff_wages_cents:100,
      staff_tax_cents:12,card_fees_cents:0,
      sales_data_status:"actual",staff_tax_status:"actual",
    }));
    const recent=snapshot({sources:{...sources,dailyRollups:daily},
      truncated:{...truncated,dailyRollups:true}});
    const available=extractAtomicSnapshot("sales.daily",recent,
      {period:{from:asOf,to:asOf}},asOf);
    expect(available?.leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({field:"netSalesCents",value:1000}),
    ]));
    const absent=extractAtomicSnapshot("sales.daily",recent,
      {period:{from:"2025-01-01",to:"2025-01-01"}},asOf);
    expect(absent?.leaves).toEqual([]);
  });
  it("COMPOSE-05: Toast pilot must not reclassify unreviewed rollups as actual sales",()=>{
    const date=asOf;
    const r={business_date:date,net_sales_cents:3000,orders_count:3,
      drinks_count:3,ingredients_cents:0,staff_wages_cents:500,
      staff_tax_cents:60,card_fees_cents:0,sales_data_status:"actual",
      staff_tax_status:"actual"} as const;
    const data=snapshot({sources:{...sources,dailyRollups:[r]}});
    vi.stubEnv("TOAST_PILOT_IMPORT_ENABLED","true");
    try{
      const projected=extractAtomicSnapshot("sales.daily",data,
        {period:{from:date,to:date}},asOf);
      expect(projected?.leaves).toEqual([]);
      expect(projected?.missingInputs).toContain(
        "toast_independent_sales_review_not_in_snapshot");
      // An unproven payroll zero is also withheld, independently of Toast.
      const labor=extractAtomicSnapshot("labor.daily_costs",data,
        {period:{from:date,to:date}},asOf);
      expect(labor?.leaves).toEqual([]);
      expect(labor?.missingInputs).toContain(
        "labor_attendance_and_wage_coverage_not_proven");
    }finally{vi.unstubAllEnvs();}
  });
  it("COMPOSE-05: foreign snapshots, truncation and mismatched epochs fail closed",()=>{
    const clause="Sophie works 45 paid minutes";
    const row=read("labor.employee_wages",clause);
    expect(projectP1Evidence([row],cafe,clause,null,[],
      snapshot({businessId:other})).operands).toHaveLength(0);
    const truncatedSnapshot=snapshot({
      sources:{...sources,employees:Array.from({length:501},(_,i)=>({
        ...sources.employees[0],id:
          "aaaaaaaa-aaaa-4aaa-8aaa-"+String(i).padStart(12,"0"),
      }))},
      truncated:{...truncated,employees:true},
    });
    expect(extractAtomicSnapshot("labor.employee_wages",truncatedSnapshot,{},asOf)
      ?.leaves).toHaveLength(0);
    const p=projectP1Evidence([row],cafe,clause,null,[],snapshot());
    const mixed=[p.operands[0],{...p.operands[0],
      handle:"second-wage",sourceRevision:"26"}];
    const output=evaluateExpression({
      capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",
      description:"Do not mix two revisions",
      nodes:[{op:"source",handle:mixed[0].handle}],
    },{businessId:cafe,locationId:null,currency:"USD",
      ownerMessage:clause,bindings:p.bindings,operands:mixed});
    expect(output).toMatchObject({status:"unavailable",reason:"mixed_source_revisions"});
  });
  it("does not attach an epoch to an independently fetched unsupported supplier quote",()=>{
    const input={clause:"Compare oat milk",capabilityId:"p3.supplies.quotes.v1",
      status:"partial" as const,reason:null,
      result:{status:"unavailable",value:null,reason:"unavailable_source"}};
    const projection=projectP1Evidence([input],cafe,input.clause,null,[],snapshot());
    expect(projection.operands).toEqual([]);
  });
});
