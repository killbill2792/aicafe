import { z } from "zod";
import type { AtomicP1SourceSnapshot } from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import { MENU_ITEM_CATEGORY_CODES } from "@/lib/constants";
import { evaluateRecipeCost, resolveProductCost } from "@/lib/calc/ingredients";
import { toBaseUnitQuantity } from "@/lib/calc/recipeUnits";
import { conditionalTargetPrice, ingredientOnlyEconomics,
  scaleMicrocents, supplierPackageMicrocents } from "@/lib/calc/alexPricingMath";

const uuid=z.string().uuid();
const cents=z.number().int().safe().min(0).max(100000000);
const amount=z.number().finite().positive().max(1000000);
const smallText=z.string().trim().min(1).max(120);
const selector=z.union([
  z.strictObject({productId:uuid}),
  z.strictObject({exactName:smallText}),
]);
const allSelection=z.strictObject({kind:z.literal("all_active"),
  offset:z.number().int().min(0).max(500),limit:z.number().int().min(1).max(25)});
const namedSelection=z.strictObject({kind:z.literal("specific"),
  items:z.array(selector).min(1).max(25)});
export const alexReviewInputSchema=z.strictObject({
  purpose:z.literal("pricing_review"),
  selection:z.discriminatedUnion("kind",[allSelection,namedSelection]),
});
const quantity=z.strictObject({value:amount,unit:z.enum(["g","ml","fl_oz","each"])});
const change=z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("ingredient_multiplier"),
    ingredientId:uuid,multiplierBasisPoints:z.number().int().min(0).max(100000)}),
  z.strictObject({kind:z.literal("ingredient_unit_cost"),
    ingredientId:uuid,costPerBaseUnitMicros:cents}),
  z.strictObject({kind:z.literal("supplier_package"),
    ingredientId:uuid,packageCostCents:cents,
    packageCount:z.number().int().min(1).max(1000000),
    packageUnit:z.enum(["gal","fl_oz","ml","g","each"])}),
  z.strictObject({kind:z.literal("replace_ingredient"),
    fromIngredientId:uuid,toIngredientId:uuid,quantity:quantity.optional()}),
  z.strictObject({kind:z.literal("set_quantity"),ingredientId:uuid,quantity}),
]);
export const alexSimulateInputSchema=z.strictObject({
  purpose:z.literal("pricing_simulate"),
  product:selector,
  changes:z.array(change).max(20),
  sellingPrice:z.discriminatedUnion("kind",[
    z.strictObject({kind:z.literal("delta"),deltaCents:z.number().int().safe().min(-100000).max(100000)}),
    z.strictObject({kind:z.literal("replace"),priceCents:cents}),
  ]).optional(),
  /** Owner selected target, NEVER a globally invented or market-derived target. */
  targetCostRatioBps:z.number().int().min(1).max(10000).optional(),
  targetIngredientMarginBps:z.number().int().min(0).max(9999).optional(),
}).refine(x=>x.targetCostRatioBps===undefined || x.targetIngredientMarginBps===undefined,
  {message:"Select exactly one target ratio or ingredient-only margin"});
export type AlexReviewInput=z.infer<typeof alexReviewInputSchema>;
export type AlexSimulateInput=z.infer<typeof alexSimulateInputSchema>;

const ratio=z.number().int().safe().nullable();
const item=z.strictObject({
  productId:uuid.nullable(),name:z.string(),category:z.string().nullable(),
  status:z.enum(["ready","partial","unavailable"]),
  currentPriceCents:cents.nullable(),ingredientCostCents:cents.nullable(),
  ingredientCostRatioBps:ratio,ingredientContributionCents:z.number().int().safe().nullable(),
  ingredientContributionRatioBps:ratio,
  costSource:z.enum(["recipe","owner_total"]).nullable(),
  recipeCostCents:cents.nullable(),
  ownerTotalCostCents:cents.nullable(),
  ownerTotalCostStatus:z.enum(["confirmed","estimated"]).nullable(),
  ownerTotalCostSource:z.enum(["owner_manual","imported"]).nullable(),
  costDifferenceCents:z.number().int().safe().nullable(),
  ingredientPriceSources:z.array(z.enum(["manual","receipt","statement","invoice"])).max(4),
  hypotheticalIngredientIds:z.array(uuid).max(20),
  staleInputs:z.array(z.string()).max(30),
  estimatedInputs:z.array(z.string()).max(30),
  currentRecommendationCents:cents.nullable(), // never synthesise recommendation from baseline profile
  missingInputs:z.array(z.string()).max(30),
});
const provenance=z.strictObject({
  sourceId:z.literal("p1.authoritative_snapshot.v1"),
  canonicalReaderId:z.literal("alex.pricing.atomic_snapshot"),
  sourceRevision:z.string(),purpose:z.string(),asOf:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const quality=z.strictObject({
  missingInputs:z.array(z.string()).max(100),
  estimatedInputs:z.array(z.string()).max(50),staleInputs:z.array(z.string()).max(50),
});
const denied=z.strictObject({
  status:z.enum(["unavailable","conflict"]),value:z.null(),reason:z.string().min(1).max(100),
});
const reviewValue=z.strictObject({
  currency:z.literal("USD"),items:z.array(item).max(25),
  totalSelected:z.number().int().min(0).max(500),offset:z.number().int().min(0).max(500),
  hasMore:z.boolean(),omittedUnsupported:z.number().int().min(0).max(500),
  recommendationScope:z.literal("unavailable_without_coherent_authoritative_pricing_evidence"),
  ownerTotalFallbackCoverage:z.enum(["not_in_p1_atomic_snapshot",
    "present_in_p1_atomic_snapshot"]),
});
export const alexReviewOutputSchema=z.union([
  denied,
  z.strictObject({status:z.enum(["verified","partial"]),value:reviewValue,provenance,quality}),
]);
const scenarioValue=z.strictObject({
  currency:z.literal("USD"),productId:uuid,name:z.string(),
  before:item,after:item,priceDeltaCents:z.number().int().safe().nullable(),
  ingredientCostDeltaCents:z.number().int().safe().nullable(),
  ingredientContributionDeltaCents:z.number().int().safe().nullable(),
  targetPriceCents:cents.nullable(),targetBasisPoints:z.number().int().nullable(),
  assumptions:z.array(z.string()).max(30),
  persisted:z.literal(false),
});
export const alexSimulateOutputSchema=z.union([
  z.strictObject({status:z.literal("unavailable"),mode:z.literal("simulate"),
    proposal:z.null(),executedEffects:z.literal(0),reason:smallText,value:z.null()}),
  z.strictObject({status:z.enum(["conditional","partial"]),mode:z.literal("simulate"),
    proposal:z.null(),executedEffects:z.literal(0),value:scenarioValue,provenance,quality}),
]);

const categoryAllowed=new Set<string>([...MENU_ITEM_CATEGORY_CODES.filter(c=>c!=="RETAIL"),"drink","food"]);
const normalize=(s:string)=>s.normalize("NFC").trim().replace(/\s+/g," ").toLocaleLowerCase("en");
type Snapshot=AtomicP1SourceSnapshot;
type OwnerTotal={
  menu_item_id:string;cost_cents:number;source_type:"owner_manual"|"imported";
  status:"confirmed"|"estimated";source_label:string|null;updated_at:string;
};
// Optional extension belongs to P1 prerequisite PR #98. No independent
// reader is permitted: legacy snapshots remain explicit "not covered".
type ExtendedSnapshot=Snapshot & {
  sources:Snapshot["sources"] & {ownerTotalCosts?:OwnerTotal[]};
  truncated:Snapshot["truncated"] & {ownerTotalCosts?:boolean};
};
const ownerCosts=(snapshot:Snapshot)=>(snapshot as ExtendedSnapshot).sources.ownerTotalCosts;
const ownerCostsTruncated=(snapshot:Snapshot)=>
  (snapshot as ExtendedSnapshot).truncated.ownerTotalCosts===true;
type Row=Snapshot["sources"]["menu"][number];
type Price=Snapshot["sources"]["ingredientPrices"][number];
const unavailableItem=(name:string,why:string,productId:string|null=null,category:string|null=null)=>
  ({productId,name,category,status:"unavailable" as const,currentPriceCents:null,
    ingredientCostCents:null,ingredientCostRatioBps:null,ingredientContributionCents:null,
    ingredientContributionRatioBps:null,costSource:null,
    recipeCostCents:null,ownerTotalCostCents:null,ownerTotalCostStatus:null,
    ownerTotalCostSource:null,costDifferenceCents:null,
    ingredientPriceSources:[] as Price["source"][],
    hypotheticalIngredientIds:[] as string[],staleInputs:[] as string[],
    estimatedInputs:[] as string[],
    currentRecommendationCents:null,missingInputs:[why]});

function findMenu(snapshot:Snapshot,query:z.infer<typeof selector>):Row|{error:string}{
  if("productId" in query){
    const row=snapshot.sources.menu.find(m=>m.id===query.productId&&m.is_active);
    return row??{error:"product_not_found_or_inactive"};
  }
  const matches=snapshot.sources.menu.filter(m=>m.is_active&&normalize(m.name)===normalize(query.exactName));
  return matches.length===1?matches[0]:
    {error:matches.length===0?"product_not_found":"ambiguous_canonical_name_use_product_id"};
}

/** Canonical historical-effective ingredient price *as of the trusted café day*.
 * Same-day duplicates are conflicts, not arbitrary row-order tie-breaks. */
function ingredientPrice(snapshot:Snapshot,id:string,day:string):Price|{error:string}{
  const rows=snapshot.sources.ingredientPrices.filter(p=>p.ingredient_id===id&&p.effective_from<=day);
  if(!rows.length)return {error:"ingredient_price_missing:"+id};
  const date=rows.reduce((max,row)=>row.effective_from>max?row.effective_from:max,"");
  const latest=rows.filter(row=>row.effective_from===date);
  return latest.length===1&&latest[0].cost_per_base_unit_micros>=0?
    latest[0]:{error:"ambiguous_or_invalid_ingredient_price:"+id};
}
const isError=(x:object):x is {error:string}=>"error" in x;

function evaluateItem(snapshot:Snapshot,row:Row,day:string,alterations:AlexSimulateInput["changes"]=[],
  newPrice?:number) {
  const missing:string[]=[];
  if(!categoryAllowed.has(row.category??""))missing.push("unsupported_category");
  const sellingPrice=newPrice??(row.price_cents!==null&&row.price_cents>=0?row.price_cents:null);
  if(sellingPrice===null)missing.push("selling_price_missing");
  const ingredientById=new Map(snapshot.sources.ingredients.map(i=>[i.id,i]));
  const lines=snapshot.sources.recipes.filter(l=>l.menu_item_id===row.id)
    .map(l=>({...l}));
  if(!lines.length)missing.push("recipe_missing");
  if(lines.length>200 || new Set(lines.map(x=>x.ingredient_id)).size!==lines.length)
    missing.push("recipe_conflict_or_over_limit");
  const priced=new Map<string,number>();
  // Provenance belongs to the FINAL cost-bearing recipe lines, not every
  // candidate retrieved before an ingredient substitution or price override.
  const recordedSourcesById=new Map<string,Price["source"]>();
  const hypotheticalPrices=new Set<string>();
  for(const id of new Set([...lines.map(l=>l.ingredient_id),
    ...alterations.flatMap(c=>c.kind==="replace_ingredient"?[c.toIngredientId]:
      "ingredientId" in c?[c.ingredientId]:[])])){
    const ingredient=ingredientById.get(id);
    if(!ingredient){missing.push("ingredient_not_in_authoritative_snapshot:"+id);continue;}
    const p=ingredientPrice(snapshot,id,day);
    if(isError(p)){missing.push(p.error);continue;}
    priced.set(id,p.cost_per_base_unit_micros);
    recordedSourcesById.set(id,p.source);
  }
  for(const edit of alterations){
    if(edit.kind==="replace_ingredient"){
      const from=ingredientById.get(edit.fromIngredientId);
      const to=ingredientById.get(edit.toIngredientId);
      const index=lines.findIndex(l=>l.ingredient_id===edit.fromIngredientId);
      if(index<0||!from||!to||from.base_unit!==to.base_unit){
        missing.push("substitution_requires_existing_compatible_recipe_line");continue;
      }
      const q=edit.quantity===undefined?lines[index].quantity:
        toBaseUnitQuantity(edit.quantity.unit,edit.quantity.value,to.base_unit);
      if(q===null||!Number.isFinite(q)||q>1000000){
        missing.push("unsupported_substitution_quantity");continue;
      }
      lines[index]={...lines[index],ingredient_id:edit.toIngredientId,quantity:q};
    }else if(edit.kind==="set_quantity"){
      const ing=ingredientById.get(edit.ingredientId);
      const index=lines.findIndex(l=>l.ingredient_id===edit.ingredientId);
      const q=ing?toBaseUnitQuantity(edit.quantity.unit,edit.quantity.value,ing.base_unit):null;
      if(index<0||q===null||!Number.isFinite(q)||q>1000000){
        missing.push("quantity_requires_existing_compatible_recipe_line");continue;
      }
      lines[index]={...lines[index],quantity:q};
    }else{
      const ing=ingredientById.get(edit.ingredientId);
      const prior=priced.get(edit.ingredientId);
      if(!ing||prior===undefined||!lines.some(l=>l.ingredient_id===edit.ingredientId)){
        missing.push("cost_change_requires_priced_recipe_ingredient");continue;
      }
      const next=edit.kind==="ingredient_unit_cost"?edit.costPerBaseUnitMicros:
        edit.kind==="ingredient_multiplier"?scaleMicrocents(prior,edit.multiplierBasisPoints):
          supplierPackageMicrocents(edit.packageCostCents,edit.packageCount,
            edit.packageUnit,ing.base_unit);
      if(next===null){missing.push("invalid_unit_or_cost_conversion");continue;}
      priced.set(edit.ingredientId,next);
      hypotheticalPrices.add(edit.ingredientId);
      // An absolute owner override is not evidence from the superseded
      // ingredient-price row. A relative multiplier still depends on that row.
      if(edit.kind!=="ingredient_multiplier")
        recordedSourcesById.delete(edit.ingredientId);
    }
  }
  // For substitutions, a newly introduced ingredient becomes a cost-bearing line.
  for(const line of lines) {
    if(!ingredientById.has(line.ingredient_id)||!Number.isFinite(line.quantity)||
      line.quantity<0||line.quantity>1000000)missing.push("invalid_recipe_line");
    if(!priced.has(line.ingredient_id))missing.push("recipe_ingredient_price_missing:"+line.ingredient_id);
  }
  if(new Set(lines.map(x=>x.ingredient_id)).size!==lines.length)
    missing.push("duplicate_ingredient_after_substitution");
  let recipeCost:number|null=null;
  if(!missing.some(m=>m!=="selling_price_missing")&&lines.length){
    const prices=Object.fromEntries(priced.entries());
    const result=evaluateRecipeCost(lines.map(x=>({
      ingredientId:x.ingredient_id,quantity:x.quantity})),prices);
    if(result.status==="READY" && result.costCents!==null)recipeCost=result.costCents;
  }
  const rows=ownerCosts(snapshot)?.filter(x=>x.menu_item_id===row.id)??[];
  if(rows.length>1)missing.push("conflicting_owner_total_cost_rows");
  const manual=rows.length===1?rows[0]:null;
  const manualCents=manual&&manual.cost_cents>0&&
    Number.isSafeInteger(manual.cost_cents)&&manual.cost_cents<=100000000?
    manual.cost_cents:null;
  if(manual&&manualCents===null)missing.push("owner_total_cost_out_of_range");
  // Canonical rule: complete positive recipe first, otherwise positive owner
  // total. Never ADD the two or turn an absent total into zero. A recorded
  // zero-cost recipe with no owner fallback is still a known zero.
  const resolved=resolveProductCost({
    status:recipeCost===null?lines.length?"MISSING_INGREDIENT_COST":"NO_RECIPE":"READY",
    costCents:recipeCost,missingIngredientIds:[],
  },manualCents);
  const selectedSource=recipeCost===0&&manualCents===null?
    "recipe" as const:resolved.source;
  const rawCost=selectedSource===null?null:resolved.costCents;
  const economics=rawCost===null||rawCost>100000000?null:
    ingredientOnlyEconomics(rawCost,sellingPrice);
  if(!economics)missing.push("ingredient_cost_unavailable_or_out_of_range");
  if(rawCost===null){
    missing.push(ownerCosts(snapshot)===undefined?
      "owner_total_cost_fallback_not_in_atomic_snapshot":"owner_total_cost_missing");
  }
  const uniqueMissing=[...new Set(missing)].slice(0,30);
  const finalIds=[...new Set(lines.map(line=>line.ingredient_id))];
  const sources=[...new Set(finalIds.flatMap(id=>{
    const source=recordedSourcesById.get(id);
    return source?[source]:[];
  }))];
  const hypotheticalIngredientIds=finalIds.filter(id=>hypotheticalPrices.has(id));
  // An effective date and source revision prove recorded input, not supplier
  // freshness. Do not invent a universal shelf life for a price observation.
  const stale=selectedSource==="recipe"?finalIds.filter(id=>recordedSourcesById.has(id))
    .map(id=>"ingredient_price_freshness_unverified:"+id):
    selectedSource==="owner_total"?["owner_total_cost_freshness_unverified"]:[];
  const staleInputs=stale.length>30?[...stale.slice(0,29),
    "additional_freshness_gaps_omitted"]:stale;
  const estimatedInputs=selectedSource==="owner_total"&&manual?.status==="estimated"?
    ["owner_total_cost_estimated"]:[];
  const out={
    productId:row.id,name:row.name,category:row.category,
    status:uniqueMissing.length||staleInputs.length||estimatedInputs.length?
      "partial" as const:"ready" as const,
    currentPriceCents:sellingPrice,
    ingredientCostCents:economics?.ingredientCostCents??null,
    ingredientCostRatioBps:economics?.costRatioBasisPoints??null,
    ingredientContributionCents:economics?.ingredientContributionCents??null,
    ingredientContributionRatioBps:economics?.ingredientContributionBasisPoints??null,
    costSource:economics?selectedSource:null,
    recipeCostCents:recipeCost===null?null:Math.round(recipeCost),
    ownerTotalCostCents:manualCents,
    ownerTotalCostStatus:manual?.status??null,
    ownerTotalCostSource:manual?.source_type??null,
    costDifferenceCents:recipeCost!==null&&manualCents!==null?
      Math.round(recipeCost-manualCents):null,
    ingredientPriceSources:selectedSource==="recipe"?sources:[],
    hypotheticalIngredientIds:selectedSource==="recipe"?hypotheticalIngredientIds:[],
    staleInputs,estimatedInputs,
    currentRecommendationCents:null,missingInputs:uniqueMissing,
  };
  return {item:out,rawCost};
}

const context=(snapshot:Snapshot,day:string,purpose:string)=>({
  sourceId:"p1.authoritative_snapshot.v1" as const,
  canonicalReaderId:"alex.pricing.atomic_snapshot" as const,
  sourceRevision:snapshot.revision,purpose,asOf:day,
});
function sourceSafe(snapshot:Snapshot):boolean{
  return snapshot.currency==="USD"&&
    !snapshot.truncated.menu&&!snapshot.truncated.ingredients&&
    !snapshot.truncated.ingredientPrices&&!snapshot.truncated.recipes&&
    !ownerCostsTruncated(snapshot);
}

export function reviewFromAtomicSnapshot(snapshot:Snapshot,input:AlexReviewInput,day:string){
  if(!sourceSafe(snapshot))return {status:"unavailable" as const,value:null,
    reason:"source_truncated_or_unsupported_currency"};
  const supported=snapshot.sources.menu.filter(x=>x.is_active&&categoryAllowed.has(x.category??""))
    .sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  const omitted=snapshot.sources.menu.filter(x=>x.is_active&&!categoryAllowed.has(x.category??"")).length;
  const offset=input.selection.kind==="all_active"?input.selection.offset:0;
  const selected=input.selection.kind==="all_active"?
    supported.slice(offset,offset+input.selection.limit):
    input.selection.items.map(q=>findMenu(snapshot,q));
  const items=selected.map(x=>isError(x)?unavailableItem("unresolved",x.error):
    evaluateItem(snapshot,x,day).item);
  const missing=items.flatMap(x=>x.missingInputs.map(m=>x.name+":"+m));
  const stale=items.flatMap(x=>x.staleInputs.map(m=>x.name+":"+m));
  const estimated=items.flatMap(x=>x.estimatedInputs.map(m=>x.name+":"+m));
  if(omitted)missing.push("unsupported_categories_omitted:"+omitted);
  const result={
    status:missing.length||stale.length||estimated.length?
      "partial" as const:"verified" as const,
    value:{currency:"USD" as const,items,totalSelected:
      input.selection.kind==="all_active"?supported.length:selected.length,offset,
      hasMore:input.selection.kind==="all_active"&&offset+selected.length<supported.length,
      omittedUnsupported:omitted,
      recommendationScope:"unavailable_without_coherent_authoritative_pricing_evidence" as const,
      ownerTotalFallbackCoverage:ownerCosts(snapshot)===undefined?
        "not_in_p1_atomic_snapshot" as const:"present_in_p1_atomic_snapshot" as const},
    provenance:context(snapshot,day,input.purpose),
    quality:{missingInputs:missing.length>100?[...missing.slice(0,99),
      "additional_missing_inputs_omitted"]:missing,
      estimatedInputs:estimated.slice(0,50),
      staleInputs:stale.length>50?[...stale.slice(0,49),
        "additional_freshness_gaps_omitted"]:stale},
  };
  return result;
}

export function simulateFromAtomicSnapshot(snapshot:Snapshot,input:AlexSimulateInput,day:string){
  const no=(reason:string)=>({status:"unavailable" as const,mode:"simulate" as const,
    proposal:null,executedEffects:0 as const,value:null,reason});
  if(!sourceSafe(snapshot))return no("source_truncated_or_unsupported_currency");
  const row=findMenu(snapshot,input.product);
  if(isError(row))return no(row.error);
  const before=evaluateItem(snapshot,row,day);
  let proposedPrice:number|undefined;
  if(input.sellingPrice){
    if(input.sellingPrice.kind==="replace")proposedPrice=input.sellingPrice.priceCents;
    else if(before.item.currentPriceCents!==null)
      proposedPrice=before.item.currentPriceCents+input.sellingPrice.deltaCents;
    else return no("price_delta_requires_recorded_price");
    if(!Number.isSafeInteger(proposedPrice)||proposedPrice<0||proposedPrice>100000000)
      return no("proposed_price_out_of_range");
  }
  const after=evaluateItem(snapshot,row,day,input.changes,proposedPrice);
  const missing=[...new Set([...before.item.missingInputs,...after.item.missingInputs])];
  const stale=[...new Set([...before.item.staleInputs,...after.item.staleInputs])];
  const estimated=[...new Set([...before.item.estimatedInputs,
    ...after.item.estimatedInputs])];
  // Manual TOTAL is not an ingredient breakdown. Price-only/target what-ifs
  // are possible; ingredient edits without complete recipe are NOT.
  if(input.changes.length>0&&after.item.costSource!=="recipe")
    return no("ingredient_scenario_requires_complete_priced_recipe");
  if(input.changes.length>0&&after.rawCost===null)return no("hypothetical_cost_inputs_incomplete");
  const targetBps=input.targetCostRatioBps??(
    input.targetIngredientMarginBps!==undefined?10000-input.targetIngredientMarginBps:null);
  const targetPriceCents=targetBps!==null&&after.rawCost!==null?
    conditionalTargetPrice(after.rawCost,targetBps):null;
  const sub=(a:number|null,b:number|null)=>a===null||b===null?null:b-a;
  return {
    status:missing.length||stale.length||estimated.length?
      "partial" as const:"conditional" as const,
    mode:"simulate" as const,proposal:null,executedEffects:0 as const,
    value:{currency:"USD" as const,productId:row.id,name:row.name,
      before:before.item,after:after.item,
      priceDeltaCents:sub(before.item.currentPriceCents,after.item.currentPriceCents),
      ingredientCostDeltaCents:sub(before.item.ingredientCostCents,after.item.ingredientCostCents),
      ingredientContributionDeltaCents:sub(before.item.ingredientContributionCents,
        after.item.ingredientContributionCents),
      targetPriceCents,targetBasisPoints:targetBps,
      assumptions:["owner_hypothetical_not_recorded",
        "recorded_cost_freshness_not_proven",
        ...(after.item.costSource==="owner_total"?[
          "owner_total_is_aggregate_not_ingredient_recipe"]:[]),
        "ingredient_only_excludes_labor_fees_rent_and_demand",
        ...(after.item.hypotheticalIngredientIds.length?[
          "owner_supplied_ingredient_cost_overrides_are_hypothetical"]:[]),
        ...(targetBps===null?["no_target_selected_no_target_price"]:[])],persisted:false as const},
    provenance:context(snapshot,day,input.purpose),
    quality:{missingInputs:missing.slice(0,100),
      estimatedInputs:estimated.slice(0,50),staleInputs:stale.slice(0,50)},
  };
}
