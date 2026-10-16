import type { AtomicP1SourceSnapshot } from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import type { SupportedId } from "@/lib/metrics/p1Catalog";
import type { Operand } from "./expression";
import { evaluateRecipeCost,ingredientUsdUsGallonCents } from "@/lib/calc/ingredients";
import { roundHalfUpToCent } from "@/lib/calc/money";
import { staffCostLoadedCents } from "@/lib/calc/staff";

/**
 * Allowlisted projections exclusively from the ONE SQL/MVCC snapshot.
 * The earlier P1 shadow reads supply audited selectors, NEVER numbers or
 * revisions in this path. Adding a source requires an explicit adapter.
 */
export type SnapshotLeaf = {key:string;name:string;field:string;
  value:number;unit:Operand["unit"]};
export type SnapshotExtraction = {leaves:SnapshotLeaf[];
  missingInputs:string[];staleInputs:string[]};
const safe=(n:unknown):n is number=>typeof n==="number"&&
  Number.isSafeInteger(n)&&Math.abs(n)<=1_000_000_000_000;
const result=(leaves:SnapshotLeaf[],missingInputs:string[]=[],
  staleInputs:string[]=[]):SnapshotExtraction=>({leaves,missingInputs,staleInputs});
const blocked=(reason:string)=>result([],[reason]);

function product(snapshot:AtomicP1SourceSnapshot,id:string,asOf:string):
  SnapshotExtraction {
  if(snapshot.truncated.menu||snapshot.truncated.recipes||
    snapshot.truncated.ingredients||snapshot.truncated.ingredientPrices)
    return blocked("snapshot_menu_or_recipe_truncated");
  const menu=snapshot.sources.menu.find(m=>m.id===id);
  if(!menu||!menu.is_active)return blocked("menu_product_not_in_snapshot");
  const name=menu.name;
  const leaves:SnapshotLeaf[]=[];
  if(safe(menu.price_cents))
    leaves.push({key:id,name,field:"priceCents",value:menu.price_cents,
      unit:"USD_cents_per_item"});
  const recipe=snapshot.sources.recipes.filter(r=>r.menu_item_id===id);
  if(recipe.length===0)return result(leaves,["recipe_missing"]);
  if(recipe.length>200||new Set(recipe.map(r=>r.ingredient_id)).size!==recipe.length)
    return blocked("invalid_or_unbounded_recipe");
  const prices:Record<string,number>={};
  for(const row of recipe){
    if(!snapshot.sources.ingredients.some(i=>i.id===row.ingredient_id)||
      !Number.isFinite(row.quantity)||row.quantity<0)
      return blocked("invalid_recipe_ingredient");
    // SQL orders by ID, NOT effective date. Choose most recent valid as-of
    // source price and reject duplicates at the chosen effective date.
    const candidates=snapshot.sources.ingredientPrices.filter(p=>
      p.ingredient_id===row.ingredient_id&&p.effective_from<=asOf)
      .sort((a,b)=>b.effective_from.localeCompare(a.effective_from));
    if(!candidates.length||!safe(candidates[0].cost_per_base_unit_micros)||
      candidates[0].cost_per_base_unit_micros<0)
      return result(leaves,["ingredient_price_missing"]);
    if(candidates.length>1&&candidates[0].effective_from===candidates[1].effective_from)
      return blocked("ambiguous_ingredient_price");
    prices[row.ingredient_id]=candidates[0].cost_per_base_unit_micros;
  }
  const computed=evaluateRecipeCost(recipe.map(r=>({
    ingredientId:r.ingredient_id,quantity:r.quantity,
  })),prices);
  if(computed.status!=="READY"||computed.costCents===null||
    !Number.isFinite(computed.costCents))
    return result(leaves,["recipe_cost_incomplete"]);
  const cents=roundHalfUpToCent(computed.costCents);
  if(!safe(cents)||cents<0)return blocked("recipe_cost_out_of_range");
  leaves.push({key:id,name,field:"ingredientsCentsToday",value:cents,
    unit:"USD_cents_per_item"});
  // Effective price is not a supplier freshness guarantee or historical COGS.
  return result(leaves,["ingredient_price_freshness_not_proven"]);
}

function daily(snapshot:AtomicP1SourceSnapshot,
  period:{from:string;to:string}|undefined,labor:boolean):SnapshotExtraction{
  // Old rows outside a completely selected recent period may be truncated.
  // Validate exact requested-date coverage below; never invent absent days.
  if(!period)return blocked("snapshot_daily_source_unselected");
  const start=Date.parse(period.from+"T12:00:00Z"),end=Date.parse(period.to+"T12:00:00Z");
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||
    (end-start)/86400000>365)return blocked("invalid_snapshot_period");
  const expected=Math.round((end-start)/86400000)+1;
  const rows=snapshot.sources.dailyRollups.filter(r=>
    r.business_date>=period.from&&r.business_date<=period.to);
  if(rows.length!==expected||new Set(rows.map(r=>r.business_date)).size!==expected)
    return blocked(labor?"labor_date_coverage_not_proven":"sales_date_coverage_not_proven");
  if(!labor&&rows.some(r=>r.sales_data_status!=="actual"))
    return blocked("sales_missing_for_selected_dates");
  const fields=labor?
    ["staff_wages_cents","staff_tax_cents"] as const:
    // The authoritative RPC currently omits card_fees_status. A recorded
    // numeric zero could mean missing/estimated rather than a known $0 fee.
    // Withhold card fees until an additive, status-preserving snapshot contract
    // is reviewed; never silently classify them as actual.
    // Historical ingredient costs lack proved item-level coverage in this RPC.
    // Only recorded net sales may be projected from this daily source.
    ["net_sales_cents"] as const;
  const names=labor?["wagesCents","staffTaxCents"] as const:
    ["netSalesCents"] as const;
  const leaves:SnapshotLeaf[]=[];
  for(let i=0;i<fields.length;i++){
    // Each SQL cent is an integer; preserve exactness even when an
    // intermediate sum is larger than MAX_SAFE_INTEGER and later negative
    // adjustments bring the final period total back into range.
    const exact=rows.reduce((sum,row)=>
      sum+BigInt(row[fields[i]]),BigInt(0));
    if(exact>BigInt("1000000000000")||
      exact<BigInt("-1000000000000"))
      return blocked("daily_total_out_of_range");
    const value=Number(exact);
    if(!safe(value))return blocked("daily_total_out_of_range");
    leaves.push({key:"aggregate",name:"daily rows",field:names[i],
      value,unit:"USD_cents"});
  }
  if(labor){
    const loaded=staffCostLoadedCents(leaves[0].value,leaves[1].value);
    if(!safe(loaded))return blocked("loaded_labor_out_of_range");
    leaves.push({key:"aggregate",name:"daily rows",
      field:"loadedStaffCostCents",value:loaded,unit:"USD_cents"});
  }
  const estimate=labor&&rows.some(row=>row.staff_tax_status==="estimated");
  return result(leaves,[labor?"labor_coverage_not_proven":
    "pos_import_date_and_item_coverage_not_proven",
    "card_fee_status_unavailable_from_atomic_snapshot",
    "historical_ingredient_cost_coverage_not_proven"],
    estimate?["estimated_payroll_tax"]:[]);
}

export function extractAtomicSnapshot(
  key:SupportedId,snapshot:AtomicP1SourceSnapshot,
  query:{period?:{from:string;to:string};productId?:string},
  asOf:string,
):SnapshotExtraction|null{
  if(snapshot.currency!=="USD")return blocked("unsupported_currency");
  switch(key){
    case "menu.catalog":
      if(snapshot.truncated.menu)return blocked("snapshot_menu_truncated");
      return result(snapshot.sources.menu.filter(row=>row.is_active&&
        safe(row.price_cents)).map(row=>({
        key:row.id,name:row.name,field:"priceCents",
        value:row.price_cents!,unit:"USD_cents_per_item" as const,
      })),["menu_price_coverage_not_proven"]);
    case "menu.ingredients":{
      if(snapshot.truncated.ingredients||snapshot.truncated.ingredientPrices)
        return blocked("snapshot_ingredient_prices_truncated");
      const leaves:SnapshotLeaf[]=[];
      for(const ingredient of snapshot.sources.ingredients){
        // Mass and count units cannot be converted to liquid US gallons.
        if(ingredient.base_unit!=="ml")continue;
        const candidates=snapshot.sources.ingredientPrices.filter(p=>
          p.ingredient_id===ingredient.id&&p.effective_from<=asOf)
          .sort((a,b)=>b.effective_from.localeCompare(a.effective_from));
        if(!candidates.length||candidates.length>1&&
          candidates[0].effective_from===candidates[1].effective_from)continue;
        const amount=ingredientUsdUsGallonCents(
          candidates[0].cost_per_base_unit_micros);
        if(amount===null||amount>1_000_000_000_000)continue;
        leaves.push({key:ingredient.id,name:ingredient.name,
          field:"pricePerGallon",value:amount,
          unit:"USD_cents_per_US_gallon"});
      }
      return result(leaves,["ingredient_price_freshness_and_option_mix_unproven"]);
    }
    case "menu.product_economics":
      return query.productId?product(snapshot,query.productId,asOf):
        blocked("missing_product_selector");
    case "labor.employee_wages":
      if(snapshot.truncated.employees)return blocked("snapshot_wages_truncated");
      return result(snapshot.sources.employees.filter(row=>row.active&&
        row.wage_period==="hour"&&safe(row.default_hourly_wage_cents)&&
        row.default_hourly_wage_cents>0).map(row=>({
        key:row.id,name:row.display_name,field:"defaultHourlyWageCents",
        value:row.default_hourly_wage_cents!,unit:"USD_cents_per_hour" as const,
      })),["wage_history_and_salary_conversion_not_proven"]);
    case "labor.payroll_burden":{
      const n=snapshot.payroll.rate*10000,rounded=Math.round(n);
      if(!safe(rounded)||Math.abs(n-rounded)>1e-7)
        return blocked("payroll_burden_precision_unsupported");
      return result([{key:"aggregate",name:"employer cost rate",
        field:"rateBasisPoints",value:rounded,unit:"ratio_bps"}],
        snapshot.payroll.status==="estimated"?["estimated_employer_burden"]:[]);
    }
    case "sales.daily":return daily(snapshot,query.period,false);
    case "labor.daily_costs":return daily(snapshot,query.period,true);
    default:return null;
  }
}
