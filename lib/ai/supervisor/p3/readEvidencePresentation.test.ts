import {describe,expect,it} from "vitest";
import type {ShadowEvidence} from "@/lib/ai/supervisor/p2/shadow.server";
import {presentRegisteredReads} from "./readEvidencePresentation";

const asOf="2026-10-16",businessId="owner-cafe";
const clause="Check supplier quotes";
function read(value:unknown,overrides:Record<string,unknown>={}):ShadowEvidence {
  return {clause,capabilityId:"p3.supplies.quotes.v1",status:"partial",reason:null,
    result:{status:"partial",id:"supplies.quotes",version:1,
      query:{id:"supplies.quotes",version:1,purpose:"owner_reported_quote_review"},
      value,quality:{missingInputs:[],estimatedInputs:[],staleInputs:[]},
      provenance:{asOf,canonicalReaderId:"readP1SupplierQuotes",
        purpose:"owner_reported_quote_review",sourceRevision:null},
      ...overrides},
  };
}
const present=(evidence:ShadowEvidence[],includedClauses=[clause],locale:"en"|"es"|"ar"="en")=>
  presentRegisteredReads({evidence,includedClauses,businessId,asOf,locale});
describe("live registered source evidence presentation",()=>{
  it("renders Maya's bounded owner-reported supplier quote without stock or verified pricing claims",()=>{
    const result=present([read({items:[{id:"internal-uuid",supplierName:"Baker Shop",
      itemName:"Oat milk",priceCents:1275,packageCount:6,
      evidenceStatus:"owner_reported",sourceUrl:"https://evil.example/click"}],
      truncated:false})]);
    expect(result.blocks.some(b=>b.type==="text"&&b.text.includes("Oat milk"))).toBe(true);
    const all=result.blocks.map(b=>b.type==="text"||b.type==="warning"?b.text:"").join(" ");
    expect(all).toContain("$12.75");
    expect(all).toContain("quote as inventory");
    expect(all).not.toContain("evil.example");
    expect(all).not.toContain("internal-uuid");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].identifier).toMatch(/^p3:read:[a-f0-9]{32}$/u);
  });
  it("never displays missing numeric zero as a known cost and does not give total coverage",()=>{
    const source=read({knownTotalCents:0,missingComponentCents:0,
      productName:"Latte",sampleCostCents:159},{
        id:"money.business_costs",
        quality:{missingInputs:["ingredient_prices_missing"],estimatedInputs:[],staleInputs:[]},
      });
    const result=present([{...source,capabilityId:"p3.money.business_costs.v1"}]);
    const all=result.blocks.map(b=>b.type==="text"||b.type==="warning"?b.text:"").join(" ");
    expect(all).not.toContain("$0.00");
    expect(all).toContain("Coverage and source revision");
    expect(result.blocks.some(b=>b.type==="warning"&&b.code==="P3_READ_PARTIAL")).toBe(true);
  });
  it("does not surface foreign-date, unavailable or unrequested capability data",()=>{
    const foreign=read({items:[{name:"leak"}]},{provenance:{
      asOf:"2026-10-15",canonicalReaderId:"readP1SupplierQuotes",
      purpose:"owner_reported_quote_review",sourceRevision:null,
    }});
    expect(present([foreign]).blocks).toHaveLength(0);
    expect(present([{...read({items:[{name:"leak"}]}),status:"unavailable"}]).blocks).toHaveLength(0);
    expect(present([read({items:[{name:"leak"}]})],["other clause"]).blocks).toHaveLength(0);
  });
  it("localizes provisional read warnings and bounds large results without exposing links",()=>{
    const sample={items:Array.from({length:40},(_,i)=>({
      itemName:"Drink "+i,sourceUrl:"https://invalid.example/",priceCents:1200+i,
    }))};
    const {blocks}=present([read(sample)],undefined,"ar");
    expect(blocks.some(b=>b.type==="warning"&&/المصدر/u.test(b.text))).toBe(true);
    expect(blocks.filter(b=>b.type==="text").length).toBeLessThanOrEqual(4);
    expect(blocks.map(b=>b.type==="text"?b.text:"").join(" ")).not.toContain("Drink 39");
  });
});
