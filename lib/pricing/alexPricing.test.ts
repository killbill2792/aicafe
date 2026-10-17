import { describe,expect,it } from "vitest";
import { atomicP1SourceSchema, type AtomicP1SourceSnapshot } from
  "@/lib/metrics/p1AtomicSourceSnapshot.server";
import { alexReviewInputSchema,alexReviewOutputSchema,alexSimulateInputSchema,
  alexSimulateOutputSchema,reviewFromAtomicSnapshot,simulateFromAtomicSnapshot } from "./alexPricing";

const id=(n:number)=>"a0000000-0000-4000-8000-"+String(n).padStart(12,"0");
const cafe=id(999),whole=id(100),oat=id(101),almond=id(102),unpriced=id(103);
const day="2026-10-16";
function snapshot():AtomicP1SourceSnapshot{
  const menu=Array.from({length:12},(_,i)=>({
    id:id(i+1),name:i===0?"Latte 12 oz":i===1?"Latte 16 oz":
      i===2?"Latte 16 oz":`Drink ${i+1}`,
    price_cents:i===3?null:500+i*25,is_active:true,
    category:i===11?"RETAIL":"ESPRESSO_DRINK",
  }));
  const val={
    contract:"p1.authoritative_snapshot.v1",businessId:cafe,revision:"42",
    timezone:"America/Los_Angeles",currency:"USD",
    payroll:{rate:0.12,status:"confirmed",source:"business"},
    sources:{
      menu,
      ingredients:[
        {id:whole,name:"Whole milk",base_unit:"ml"},
        {id:oat,name:"Oat milk",base_unit:"ml"},
        {id:almond,name:"Almond milk",base_unit:"ml"},
        {id:unpriced,name:"Unknown flavor",base_unit:"ml"},
      ],
      ingredientPrices:[
        {id:id(201),ingredient_id:whole,effective_from:"2026-09-01",
          cost_per_base_unit_micros:100000,source:"manual"},
        {id:id(202),ingredient_id:oat,effective_from:"2026-09-01",
          cost_per_base_unit_micros:200000,source:"receipt"},
        {id:id(203),ingredient_id:almond,effective_from:"2026-09-01",
          cost_per_base_unit_micros:150000,source:"invoice"},
      ],
      recipes:menu.filter((_,i)=>i!==4).map((row,i)=>({
        menu_item_id:row.id,ingredient_id:i===5?unpriced:whole,quantity:200,
      })),
      employees:[],dailyRollups:[],expenses:[],recurringCosts:[],imports:[],
    },
    truncated:{menu:false,ingredients:false,ingredientPrices:false,recipes:false,
      employees:false,dailyRollups:false,expenses:false,recurringCosts:false,imports:false},
    coverage:"not_proven_by_revision",
  };
  return atomicP1SourceSchema.parse(val);
}
const review=(input:unknown)=>alexReviewInputSchema.parse(input);
const scenario=(input:unknown)=>alexSimulateInputSchema.parse(input);

describe("Alex atomic canonical review and scenarios",()=>{
  it("pages twelve menu products, preserves per-item missing costs, prices and unsupported omissions",()=>{
    const input=review({purpose:"pricing_review",selection:{kind:"all_active",offset:0,limit:10}});
    const first=reviewFromAtomicSnapshot(snapshot(),input,day);
    expect(alexReviewOutputSchema.safeParse(first).success).toBe(true);
    expect(first.status).toBe("partial");
    if(first.status==="unavailable")throw Error("expected partial");
    expect(first.value.items).toHaveLength(10);
    expect(first.value.totalSelected).toBe(11);
    expect(first.value.hasMore).toBe(true);
    expect(first.value.omittedUnsupported).toBe(1);
    expect(first.value.items.find(x=>x.name==="Latte 12 oz")).toMatchObject({
      productId:id(1),ingredientCostCents:20,currentPriceCents:500,costSource:"recipe",
      ingredientContributionCents:480});
    const second=reviewFromAtomicSnapshot(snapshot(),
      review({purpose:"pricing_review",selection:{kind:"all_active",offset:10,limit:10}}),day);
    if(second.status==="unavailable")throw Error("expected second page");
    expect(second.value.items).toHaveLength(1);
    expect(second.value.hasMore).toBe(false);
  });
  it("rejects duplicate exact names but resolves size-specific ID and non-drink category explicitly",()=>{
    const input=review({purpose:"pricing_review",selection:{kind:"specific",items:[
      {exactName:"Latte 16 oz"},{productId:id(2)},{productId:id(12)},
      {productId:id(500)}]}});
    const result=reviewFromAtomicSnapshot(snapshot(),input,day);
    if(result.status==="unavailable")throw Error("expected partial");
    expect(result.value.items[0].missingInputs).toContain("ambiguous_canonical_name_use_product_id");
    expect(result.value.items[1].productId).toBe(id(2));
    expect(result.value.items[2].missingInputs).toContain("unsupported_category");
    expect(result.value.items[3].status).toBe("unavailable");
    expect(alexReviewOutputSchema.safeParse(result).success).toBe(true);
  });
  it("substitutes oat for whole on a specific variant without changing the source snapshot",()=>{
    const s=snapshot(),before=JSON.stringify(s);
    const result=simulateFromAtomicSnapshot(s,scenario({
      purpose:"pricing_simulate",product:{productId:id(1)},
      changes:[{kind:"replace_ingredient",fromIngredientId:whole,toIngredientId:oat,
        quantity:{value:200,unit:"ml"}}],sellingPrice:{kind:"delta",deltaCents:50},
      targetCostRatioBps:2500}),day);
    expect(result.status).toBe("partial");
    if(result.status==="unavailable")throw Error("scenario unavailable");
    expect(result.value.before.ingredientCostCents).toBe(20);
    expect(result.value.after.ingredientCostCents).toBe(40);
    expect(result.value.before.ingredientPriceSources).toEqual(["manual"]);
    expect(result.value.after.ingredientPriceSources).toEqual(["receipt"]);
    expect(result.value.after.hypotheticalIngredientIds).toEqual([]);
    expect(result.quality.staleInputs).toEqual(expect.arrayContaining([
      "ingredient_price_freshness_unverified:"+whole,
      "ingredient_price_freshness_unverified:"+oat,
    ]));
    expect(result.value.ingredientCostDeltaCents).toBe(20);
    expect(result.value.priceDeltaCents).toBe(50);
    expect(result.value.targetPriceCents).toBe(160);
    expect(result.value.persisted).toBe(false);
    expect(alexSimulateOutputSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(s)).toBe(before);
  });
  it("applies 30% oat milk price rise to recorded oat recipe and 50 cent sale rise",()=>{
    const s=snapshot();
    s.sources.recipes[0].ingredient_id=oat;
    const result=simulateFromAtomicSnapshot(s,scenario({
      purpose:"pricing_simulate",product:{productId:id(1)},
      changes:[{kind:"ingredient_multiplier",ingredientId:oat,multiplierBasisPoints:13000}],
      sellingPrice:{kind:"delta",deltaCents:50}}),day);
    if(result.status==="unavailable")throw Error("expected scenario");
    expect(result.value.before.ingredientCostCents).toBe(40);
    expect(result.value.after.ingredientCostCents).toBe(52);
    expect(result.value.after.currentPriceCents).toBe(550);
    expect(result.value.targetPriceCents).toBeNull();
  });
  it("supports gallon supplier quote but rejects incompatible density assumptions",()=>{
    const valid=simulateFromAtomicSnapshot(snapshot(),scenario({
      purpose:"pricing_simulate",product:{productId:id(1)},
      changes:[{kind:"supplier_package",ingredientId:whole,
        packageCostCents:400,packageCount:1,packageUnit:"gal"}]}),day);
    if(valid.status==="unavailable")throw Error("expected gallon calculation");
    expect(valid.value.after.ingredientCostCents).toBe(21);
    const invalid=simulateFromAtomicSnapshot(snapshot(),scenario({
      purpose:"pricing_simulate",product:{productId:id(1)},
      changes:[{kind:"supplier_package",ingredientId:whole,
        packageCostCents:400,packageCount:1,packageUnit:"g"}]}),day);
    expect(invalid.status).toBe("unavailable");
  });
  it("fails incomplete costs, missing prices, unauthorized revisions and malformed arguments",()=>{
    const s=snapshot();
    const missing=reviewFromAtomicSnapshot(s,review({purpose:"pricing_review",
      selection:{kind:"specific",items:[{productId:id(4)},{productId:id(5)},
        {productId:id(7)}]}}),day);
    if(missing.status==="unavailable")throw Error("expected review");
    expect(missing.value.items[0].missingInputs).toContain("selling_price_missing");
    expect(missing.value.items[1].missingInputs).toContain("recipe_missing");
    expect(missing.value.items[2].missingInputs.some(x=>x.includes("price_missing"))).toBe(true);
    expect(alexReviewInputSchema.safeParse({purpose:"pricing_review",
      selection:{kind:"specific",items:[{productId:id(1),businessId:id(999)}]}}).success).toBe(false);
    expect(alexSimulateInputSchema.safeParse({purpose:"pricing_simulate",
      product:{productId:id(1)},changes:[],targetCostRatioBps:0}).success).toBe(false);
    expect(alexSimulateInputSchema.safeParse({purpose:"pricing_simulate",
      product:{productId:id(1)},changes:[],currency:"EUR"}).success).toBe(false);
    s.truncated.recipes=true;
    expect(reviewFromAtomicSnapshot(s,review({purpose:"pricing_review",
      selection:{kind:"all_active",offset:0,limit:10}}),day).status).toBe("unavailable");
  });
  it("distinguishes recorded zero cost from missing data and conflicting source rows",()=>{
    const zero=snapshot();
    zero.sources.ingredientPrices[0].cost_per_base_unit_micros=0;
    const selected=review({purpose:"pricing_review",selection:{kind:"specific",
      items:[{productId:id(1)}]}});
    const clean=reviewFromAtomicSnapshot(zero,selected,day);
    if(clean.status==="unavailable")throw Error("unexpected unavailable");
    expect(clean.value.items[0]).toMatchObject({
      ingredientCostCents:0,ingredientCostRatioBps:0,
      ingredientContributionCents:500,costSource:"recipe",currentRecommendationCents:null,
    });
    const conflicting=snapshot();
    conflicting.sources.ingredientPrices.push({...conflicting.sources.ingredientPrices[0],
      id:id(301)});
    const ambiguous=reviewFromAtomicSnapshot(conflicting,selected,day);
    if(ambiguous.status==="unavailable")throw Error("unexpected unavailable");
    expect(ambiguous.status).toBe("partial");
    expect(ambiguous.value.items[0].ingredientCostCents).toBeNull();
    expect(ambiguous.value.items[0].missingInputs.some(x=>
      x.includes("ambiguous_or_invalid_ingredient_price"))).toBe(true);
    expect(ambiguous.value.ownerTotalFallbackCoverage).toBe("not_in_p1_atomic_snapshot");
  });

  it("keeps recognized ingredient-cost amounts partial when supplier freshness is unproven",()=>{
    const selected=review({purpose:"pricing_review",selection:{kind:"specific",
      items:[{productId:id(1)}]}});
    const result=reviewFromAtomicSnapshot(snapshot(),selected,day);
    if(result.status==="unavailable")throw Error("unexpected unavailable");
    expect(result.status).toBe("partial");
    expect(result.value.items[0]).toMatchObject({
      productId:id(1),ingredientCostCents:20,status:"partial",
      ingredientPriceSources:["manual"],hypotheticalIngredientIds:[],
    });
    expect(result.value.items[0].missingInputs).toEqual([]);
    expect(result.value.items[0].staleInputs).toEqual([
      "ingredient_price_freshness_unverified:"+whole,
    ]);
    expect(result.quality.staleInputs).toContain(
      "Latte 12 oz:ingredient_price_freshness_unverified:"+whole);
    expect(alexReviewOutputSchema.safeParse(result).success).toBe(true);
  });
  it("does not attribute an absolute owner cost override to superseded price evidence",()=>{
    const outcome=simulateFromAtomicSnapshot(snapshot(),scenario({
      purpose:"pricing_simulate",product:{productId:id(1)},
      changes:[{kind:"ingredient_unit_cost",ingredientId:whole,
        costPerBaseUnitMicros:500000}],
    }),day);
    if(outcome.status==="unavailable")throw Error("override unavailable");
    expect(outcome.status).toBe("partial"); // baseline lacks verified freshness
    expect(outcome.value.before.ingredientPriceSources).toEqual(["manual"]);
    expect(outcome.value.after.ingredientPriceSources).toEqual([]);
    expect(outcome.value.after.hypotheticalIngredientIds).toEqual([whole]);
    expect(outcome.value.after.staleInputs).toEqual([]);
    expect(outcome.value.before.staleInputs).toEqual([
      "ingredient_price_freshness_unverified:"+whole]);
    expect(outcome.value.after.ingredientCostCents).toBe(100);
    expect(outcome.value.assumptions).toContain(
      "owner_supplied_ingredient_cost_overrides_are_hypothetical");
    expect(alexSimulateOutputSchema.safeParse(outcome).success).toBe(true);
    const gallon=simulateFromAtomicSnapshot(snapshot(),scenario({
      purpose:"pricing_simulate",product:{productId:id(1)},
      changes:[{kind:"supplier_package",ingredientId:whole,
        packageCostCents:400,packageCount:1,packageUnit:"gal"}],
    }),day);
    if(gallon.status==="unavailable")throw Error("supplier override unavailable");
    expect(gallon.value.after.ingredientPriceSources).toEqual([]);
    expect(gallon.value.after.hypotheticalIngredientIds).toEqual([whole]);
  });
  it("keeps recorded price provenance for relative multipliers and separates the what-if",()=>{
    const out=simulateFromAtomicSnapshot(snapshot(),scenario({
      purpose:"pricing_simulate",product:{productId:id(1)},
      changes:[{kind:"ingredient_multiplier",ingredientId:whole,
        multiplierBasisPoints:13000}],
    }),day);
    if(out.status==="unavailable")throw Error("unexpected unavailable");
    expect(out.value.after.ingredientPriceSources).toEqual(["manual"]);
    expect(out.value.after.hypotheticalIngredientIds).toEqual([whole]);
    expect(out.value.after.staleInputs).toContain(
      "ingredient_price_freshness_unverified:"+whole);
  });

  it("uses atomic owner-entered totals when recipe rows are absent, including price-only what-ifs",()=>{
    const old=snapshot();
    const extended={...old,
      sources:{...old.sources,ownerTotalCosts:[{
        menu_item_id:id(5),cost_cents:105,status:"confirmed" as const,
        source_type:"owner_manual" as const,source_label:"Owner cost for 12oz",
        updated_at:"2026-10-16T16:00:00+00:00"}]},
      truncated:{...old.truncated,ownerTotalCosts:false},
    };
    const selected=review({purpose:"pricing_review",selection:{kind:"specific",
      items:[{productId:id(5)}]}});
    const out=reviewFromAtomicSnapshot(extended,selected,day);
    if(out.status==="unavailable")throw Error("owner cost review unavailable");
    expect(out.value.ownerTotalFallbackCoverage).toBe("present_in_p1_atomic_snapshot");
    expect(out.value.items[0]).toMatchObject({
      productId:id(5),currentPriceCents:600,ingredientCostCents:105,
      costSource:"owner_total",ownerTotalCostCents:105,
      ownerTotalCostStatus:"confirmed",ownerTotalCostSource:"owner_manual",
      recipeCostCents:null,ingredientContributionCents:495,
      staleInputs:["owner_total_cost_freshness_unverified"],
    });
    const priceOnly=simulateFromAtomicSnapshot(extended,scenario({
      purpose:"pricing_simulate",product:{productId:id(5)},changes:[],
      sellingPrice:{kind:"delta",deltaCents:50},targetCostRatioBps:3000,
    }),day);
    if(priceOnly.status==="unavailable")throw Error("price-only scenario unavailable");
    expect(priceOnly.value).toMatchObject({
      priceDeltaCents:50,ingredientCostDeltaCents:0,
      ingredientContributionDeltaCents:50,targetPriceCents:350,
      before:{costSource:"owner_total",ingredientCostCents:105},
      after:{costSource:"owner_total",ingredientCostCents:105,currentPriceCents:650},
    });
    expect(priceOnly.value.persisted).toBe(false);
    expect(alexReviewOutputSchema.safeParse(out).success).toBe(true);
    expect(alexSimulateOutputSchema.safeParse(priceOnly).success).toBe(true);
    expect(JSON.stringify(extended.sources.ownerTotalCosts)).toContain("105");
    // No invented ingredient breakdown: the total cannot answer milk quantity.
    const invalid=simulateFromAtomicSnapshot(extended,scenario({
      purpose:"pricing_simulate",product:{productId:id(5)},
      changes:[{kind:"ingredient_unit_cost",ingredientId:whole,costPerBaseUnitMicros:500000}],
    }),day);
    expect(invalid).toMatchObject({status:"unavailable",
      reason:"ingredient_scenario_requires_complete_priced_recipe"});
    expect(reviewFromAtomicSnapshot(old,selected,day)).toMatchObject({
      status:"partial",value:{ownerTotalFallbackCoverage:"not_in_p1_atomic_snapshot",
        items:[{ingredientCostCents:null}]}});
  });
  it("preserves canonical recipe-first precedence and identifies estimated manual costs",()=>{
    const base=snapshot();
    const data={...base,sources:{...base.sources,ownerTotalCosts:[
      {menu_item_id:id(1),cost_cents:180,status:"confirmed" as const,
        source_type:"owner_manual" as const,source_label:null,
        updated_at:"2026-10-16T00:00:00+00:00"},
      {menu_item_id:id(7),cost_cents:220,status:"estimated" as const,
        source_type:"imported" as const,source_label:"Seeded placeholder",
        updated_at:"2026-10-16T00:00:00+00:00"},
    ]},truncated:{...base.truncated,ownerTotalCosts:false}};
    const input=review({purpose:"pricing_review",selection:{kind:"specific",
      items:[{productId:id(1)},{productId:id(7)}]}});
    const out=reviewFromAtomicSnapshot(data,input,day);
    if(out.status==="unavailable")throw Error("no review");
    expect(out.value.items[0]).toMatchObject({costSource:"recipe",
      recipeCostCents:20,ownerTotalCostCents:180,costDifferenceCents:-160,
      ingredientCostCents:20});
    expect(out.value.items[1]).toMatchObject({costSource:"owner_total",
      ingredientCostCents:220,ownerTotalCostStatus:"estimated",
      ownerTotalCostSource:"imported",
      estimatedInputs:["owner_total_cost_estimated"]});
    expect(out.quality.estimatedInputs).toContain(
      "Drink 7:owner_total_cost_estimated");
    const incomplete={...data,truncated:{...data.truncated,ownerTotalCosts:true}};
    expect(reviewFromAtomicSnapshot(incomplete,input,day))
      .toMatchObject({status:"unavailable",reason:"source_truncated_or_unsupported_currency"});
  });

});
