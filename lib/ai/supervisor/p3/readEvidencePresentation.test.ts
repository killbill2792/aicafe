import {describe,expect,it} from "vitest";
import type {ShadowEvidence} from "@/lib/ai/supervisor/p2/shadow.server";
import {presentRegisteredReads,registeredReadReason} from "./readEvidencePresentation";

const asOf="2026-10-16",businessId="owner-cafe";
const clause="Show the supplier quotes I recorded";
function read(id:string,value:unknown,
  overrides:Record<string,unknown>={}):ShadowEvidence{
  return {clause,capabilityId:"p3."+id+".v1",status:"partial",reason:null,
    result:{status:"partial",id,version:1,
      query:{id,version:1,purpose:"owner_reported_quote_review"},
      value,quality:{missingInputs:[],estimatedInputs:[],staleInputs:[]},
      provenance:{asOf,canonicalReaderId:"readP1SupplierQuotes",
        purpose:"owner_reported_quote_review",sourceRevision:null},
      ...overrides},
  };
}
const present=(evidence:ShadowEvidence[],includedClauses=[clause],locale:"en"|"es"|"ar"="en")=>
  presentRegisteredReads({evidence,includedClauses,businessId,asOf,locale});
describe("reviewed localized source presentation",()=>{
  it("presents a bounded Maya quote but never raw URLs, IDs or internal enums",()=>{
    const result=present([read("supplies.quotes",{items:[{
      id:"internal-uuid",supplierName:"Baker Shop",itemName:"Oat milk",
      priceCents:1275,packageCount:6,packageUnit:"case",evidenceStatus:"owner_reported",
      sourceKind:"supplier_quote",sourceUrl:"https://evil.example/click",
    }],truncated:false})]);
    const all=result.blocks.map(b=>"text" in b?b.text:"").join(" ");
    expect(all).toContain("Oat milk");
    expect(all).toContain("$12.75");
    expect(all).toContain("Quoted package price");
    expect(all).toContain("Package quantity: 6 cases");
    expect(all).not.toMatch(/supplier Name|source Kind|internal-uuid|supplier_quote|evil.example/u);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].identifier).toMatch(/^p3:read:[a-f0-9]{32}$/u);
    expect(result.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"warning",code:"P3_READ_PARTIAL"}),
    ]));
  });
  it("retains a recorded free menu price even with unrelated missing sources",()=>{
    const evidence=read("menu.catalog",[{id:"free",name:"Complimentary sample",
      priceCents:0,priceStatus:"recorded",active:true},{
      id:"missing",name:"Unpriced item",priceCents:null,
      priceStatus:"unrecorded",active:true,
    }],{quality:{missingInputs:["unpriced_item"],estimatedInputs:[],staleInputs:[]}});
    const all=present([evidence]).blocks.map(b=>"text" in b?b.text:"").join(" ");
    expect(all).toContain("$0.00");
    expect(all).toContain("Complimentary sample");
    expect(all).toContain("Unpriced item");
    expect(all.match(/\$0\.00/gu)).toHaveLength(1);
  });
  it("does not expose invented unknown cost totals or unsupported source fields",()=>{
    const src=read("money.business_costs",{knownTotalCents:0,
      missingComponentCents:0,productName:"Latte"},
      {quality:{missingInputs:["missing_cost"],estimatedInputs:[],staleInputs:[]}});
    const result=present([src]);
    expect(result.blocks).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
  });
  it("uses native Spanish and Arabic labels without leaking schema keys",()=>{
    const quote=read("supplies.quotes",{items:[{
      itemName:"Leche de avena",supplierName:"Proveedor A",priceCents:1275,
      sourceKind:"supplier_quote",evidenceStatus:"owner_reported",
    }]});
    for(const locale of ["es","ar"] as const){
      const all=present([quote],undefined,locale).blocks.map(b=>
        "text" in b?b.text:"").join(" ");
      expect(all).toContain("Leche de avena");
      expect(all).not.toMatch(/supplier Name|source Kind|supplier_quote|owner_reported|supplies\.quotes/u);
      expect(all).toContain(locale==="es"?"Proveedor":"المورد");
    }
  });
  it("labels each estimated expense entry and recurring bill in all supported languages",()=>{
    const expense=read("money.expense_entries",[
      {amountCents:2000,status:"estimated"},
      {amountCents:1000,status:"actual"},
    ]);
    const recurring=read("money.recurring_bill_rows",[
      {label:"Rent",amountCents:30000,isEstimate:true},
    ]);
    const expected={
      en:{expense:"Estimated expense; not confirmed as paid",
        bill:"Estimated recurring obligation"},
      es:{expense:"Gasto estimado; el pago no está confirmado",
        bill:"Obligación recurrente estimada"},
      ar:{expense:"نفقة تقديرية؛ لم يُؤكد دفعها",
        bill:"التزام متكرر تقديري"},
    } as const;
    for(const locale of ["en","es","ar"] as const){
      const estimated=present([expense],undefined,locale).blocks
        .filter(b=>b.type==="text").map(b=>b.text).join(" ");
      const bill=present([recurring],undefined,locale).blocks
        .filter(b=>b.type==="text").map(b=>b.text).join(" ");
      expect(estimated).toContain(expected[locale].expense);
      expect(bill).toContain(expected[locale].bill);
      expect(estimated).not.toContain("status:");
    }
  });
  it("keeps localized package units and never exposes raw enum values",()=>{
    const quote=read("supplies.quotes",{items:[{
      itemName:"Oat milk",supplierName:"Supplier",priceCents:1275,
      packageCount:6,packageUnit:"gal",sourceKind:"supplier_quote",
    }]});
    const spanish=present([quote],undefined,"es").blocks
      .filter(b=>b.type==="text").map(b=>b.text).join(" ");
    expect(spanish).toContain("6 galones estadounidenses");
    expect(spanish).not.toContain("supplier_quote");
  });
  it("labels owner-total fallback as estimated rather than recipe ingredient cost",()=>{
    const estimated=read("menu.product_economics",{
      name:"Latte",priceCents:525,ingredientsCentsToday:240,
      costStatus:"READY",costSource:"owner_total",costQuality:"estimated",
    });
    const all=present([estimated]).blocks.map(b=>"text" in b?b.text:"").join(" ");
    expect(all).toContain("Estimated owner-entered total product cost");
    expect(all).toContain("$2.40");
    expect(all).not.toContain("Current recipe ingredients:");
    const missing=read("menu.product_economics",{
      name:"Latte",priceCents:525,ingredientsCentsToday:0,
      costStatus:"NO_RECIPE",costSource:null,costQuality:null,
    });
    const withheld=present([missing]).blocks.map(b=>"text" in b?b.text:"").join(" ");
    expect(withheld).not.toContain("Current recipe ingredients");
    expect(withheld).not.toContain("$0.00");
  });
  it("labels monthly and annual wages by period without inventing an hourly rate",()=>{
    const wages=read("labor.employee_wages",[
      {id:"a",name:"Worker A",active:true,wageKnown:true,
        wagePeriod:"month",wageAmountCents:300000,defaultHourlyWageCents:0},
      {id:"b",name:"Worker B",active:true,wageKnown:true,
        wagePeriod:"year",wageAmountCents:3600000,defaultHourlyWageCents:0},
    ]);
    const en=present([wages]).blocks.map(b=>"text" in b?b.text:"").join(" ");
    expect(en).toContain("Recorded wage (month): $3,000.00");
    expect(en).toContain("Recorded wage (year): $36,000.00");
    expect(en).not.toContain("Hourly wage:");
    const es=present([wages],undefined,"es").blocks.map(b=>"text" in b?b.text:"").join(" ");
    expect(es).toContain("Salario registrado (mes)");
    expect(es).toContain("Salario registrado (año)");
  });
  it("uses locale catalogs for unsupported, missing and effect-denial copy",()=>{
    expect(registeredReadReason("en","unsupported")).toContain("cannot yet complete");
    expect(registeredReadReason("es","missing_input")).toContain("Faltan registros");
    expect(registeredReadReason("ar","unsupported_action")).toContain("موافقة");
  });
  it("rejects foreign date, unavailable and unrequested records",()=>{
    const foreign=read("supplies.quotes",{items:[{itemName:"leak"}]},{provenance:{
      asOf:"2026-10-15",canonicalReaderId:"readP1SupplierQuotes",
      purpose:"owner_reported_quote_review",sourceRevision:null,
    }});
    expect(present([foreign]).blocks).toHaveLength(0);
    expect(present([{...read("supplies.quotes",{items:[{itemName:"leak"}]}),
      status:"unavailable"}]).blocks).toHaveLength(0);
    expect(present([read("supplies.quotes",{items:[{itemName:"leak"}]})],
      ["another clause"]).blocks).toHaveLength(0);
  });
  it("bounds large arrays and does not surface links",()=>{
    const quote=read("supplies.quotes",{items:Array.from({length:40},(_,i)=>({
      itemName:"Drink "+i,sourceUrl:"https://invalid.example/",priceCents:1200+i,
    }))});
    const {blocks}=present([quote],undefined,"ar");
    expect(blocks.some(b=>b.type==="warning"&&/المصدر|السجلات/u.test(b.text))).toBe(true);
    expect(blocks.filter(b=>b.type==="text").length).toBeLessThanOrEqual(4);
    expect(blocks.map(b=>"text" in b?b.text:"").join(" ")).not.toContain("Drink 39");
  });
});

it("reports oversized evidence explicitly instead of cutting results or caveats",()=>{
  const clauses=["first scenario","second scenario","third scenario","fourth scenario"];
  const evidence=clauses.map(c=>({...read("alex.pricing.what_if",[{name:"Latte",
    changesSummary:Array.from({length:20},()=>({kind:"replace_ingredient",
      fromIngredientName:"A".repeat(240),toIngredientName:"B".repeat(240)})),
    ingredientCostDeltaCents:20,ingredientContributionDeltaCents:-20,
    assumptionCodes:["ingredient_only_excludes_labor_fees_rent_and_demand"]}]),clause:c}));
  for(const locale of ["en","es","ar"] as const){
    const result=present(evidence,clauses,locale);
    expect(result.blocks).toEqual([expect.objectContaining({type:"warning",code:"P3_PRESENTATION_LIMIT"})]);
    expect(result.evidence).toEqual([]);
  }
});
