import {describe,expect,it} from "vitest";
import type {ShadowEvidence} from "@/lib/ai/supervisor/p2/shadow.server";
import {presentRegisteredReads} from "./readEvidencePresentation";

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
      priceCents:1275,packageCount:6,evidenceStatus:"owner_reported",
      sourceKind:"supplier_quote",sourceUrl:"https://evil.example/click",
    }],truncated:false})]);
    const all=result.blocks.map(b=>"text" in b?b.text:"").join(" ");
    expect(all).toContain("Oat milk");
    expect(all).toContain("$12.75");
    expect(all).toContain("Recorded price");
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
