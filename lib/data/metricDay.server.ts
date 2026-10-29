import "server-only";
import {z} from "zod";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {reconcileAttributedItemRevenue,reconcileItemUnitsToCanonical} from "@/lib/calc/metrics/reconcileItemRevenue";
import { readPeriodItemSales } from "./periodItemSales.server";
import { latestEffectiveIngredientPrice } from "@/lib/calc/ingredientPriceSelection";
import { verifiedDailyCogs, type MetricDailyInput, type ItemEvidence } from "@/lib/calc/metrics/catalog";
import type { Timecard, RecipeLine } from "@/lib/calc/types";

/** One café day of certified metric inputs for lib/calc/metrics/catalog.
 * Every flag is proved from a source (SQL totals, item reconciliation, recipe
 * coverage); an unproved input stays unverified, never assumed. Used by goals. */
export async function readMetricDay(businessId:string,date:string,
  opts:{items:boolean;hours:boolean;ingredientIds:string[];itemIds?:string[];costs?:boolean},
  signal?:AbortSignal):Promise<MetricDailyInput> {
  const db=createAdminSupabaseClient(signal);
  const day=await db.from("daily_rollups").select(
    "business_date,net_sales_cents,orders_count,drinks_count,ingredients_cents,staff_wages_cents,staff_tax_cents,labor_wage_status,staff_tax_status,sales_data_status,card_fees_cents,voids_cents"
  ).eq("business_id",businessId).eq("business_date",date).maybeSingle();
  if(day.error)throw day.error;
  const facts=day.data?{
    date:day.data.business_date,netSalesCents:Number(day.data.net_sales_cents),
    ordersCount:Number(day.data.orders_count),drinksCount:Number(day.data.drinks_count),
    ingredientsCents:Number(day.data.ingredients_cents),wagesCents:day.data.staff_wages_cents==null?null:Number(day.data.staff_wages_cents),
    staffTaxCents:day.data.staff_tax_cents==null?null:Number(day.data.staff_tax_cents),laborWageStatus:day.data.labor_wage_status,staffTaxStatus:day.data.staff_tax_status,
    salesDataStatus:day.data.sales_data_status,
    cardFeesCents:Number(day.data.card_fees_cents),voidsCents:Number(day.data.voids_cents),
  }:undefined;
  const input:MetricDailyInput={date,facts};
  // A SQL-side exact count and sum prove source completeness independently of
  // the rollup's row-limited POS reader. Aggregate-only CSV sales can prove
  // their NET TOTAL without inventing transaction counts or average tickets.
  const source=await db.rpc("initiative_daily_order_sales_proof",{
    p_business_id:businessId,p_date:date,
  }).single();
  if(source.error||!source.data)throw new Error("sales provenance unavailable");
  const proof=z.strictObject({
    order_count:z.coerce.number().int().nonnegative(),
    net_sales_cents:z.coerce.number().int(),
    synthetic_count:z.coerce.number().int().nonnegative(),
  }).parse(source.data);
  const orderCount=proof.order_count;
  const netSourceCents=proof.net_sales_cents;
  const syntheticCount=proof.synthetic_count;
  const validNumbers=[orderCount,netSourceCents,syntheticCount]
    .every(Number.isSafeInteger);
  input.salesTotalCoverageVerified=Boolean(facts&&facts.salesDataStatus==="actual"&&
    validNumbers&&netSourceCents===facts.netSalesCents);
  input.transactionCountVerified=Boolean(input.salesTotalCoverageVerified&&
    syntheticCount===0&&orderCount===facts?.ordersCount);
  const itemIds=opts.itemIds??[];
  if(itemIds.length){
    const distinct=[...new Set(itemIds)];
    const scoped=await db.from("menu_items").select("id")
      .eq("business_id",businessId).in("id",distinct);
    if(scoped.error)throw scoped.error;
    input.validItemIds=(scoped.data??[]).map(row=>row.id);
  }
  if(opts.hours){
    const [orders,timecards,timezone]=await Promise.all([
      db.from("orders").select("closed_at,net_sales_cents").eq("business_id",businessId)
        .eq("toast_excluded",false).is("superseded_by",null)
        .eq("business_date",date).limit(1001),
      db.from("timecards").select("clock_in,clock_out,hourly_wage_cents,breaks,source_type,source_provider")
        .eq("business_id",businessId)
        .gte("clock_in",new Date(Date.parse(date+"T00:00:00Z")-86400000).toISOString())
        .lt("clock_in",new Date(Date.parse(date+"T00:00:00Z")+172800000).toISOString()).limit(1001),
      db.from("businesses").select("timezone").eq("id",businessId).single(),
    ]);
    if(orders.error||timecards.error||timezone.error)throw new Error("hourly sources unavailable");
    if((orders.data??[]).length<=1000&&(timecards.data??[]).length<=1000){
      input.orders=(orders.data??[]).map(o=>({closedAt:o.closed_at,netSalesCents:Number(o.net_sales_cents)}));
      input.timecards=(timecards.data??[]).map(t=>({
        clockIn:t.clock_in,clockOut:t.clock_out,hourlyWageCents:t.hourly_wage_cents==null?null:Number(t.hourly_wage_cents),
        breaks:Array.isArray(t.breaks)?t.breaks as Timecard["breaks"]:[],
        sourceType:t.source_type,sourceProvider:t.source_provider,
      }));
      input.timezone=timezone.data?.timezone;
      // Presence of timecards (even imported ones) is not a completeness
      // certificate for ALL paid attendance. owner_schedule is only a plan.
      input.attendanceSources=[...new Set((timecards.data??[]).map(t=>t.source_type))];
      input.attendanceCoverageVerified=false;
    }
  }
  const needed=new Set(opts.ingredientIds);
  if(opts.items){
    // Item economics cannot be inferred from a covered daily total alone.
    // Canonical POS provenance first proves exact item participation.
    const coverage=await readPeriodItemSales(db,businessId,{from:date,to:date});
    if(!coverage.covered){
      // Distinguish an authoritative unlinked POS line from a temporary read
      // outage. Only the former invalidates previously verified item values.
      const unlinked=await db.from("order_lines")
        .select("id,orders!inner(business_id,business_date)",{count:"exact",head:true})
        .is("menu_item_id",null).eq("voided",false)
        .eq("orders.business_id",businessId).eq("orders.business_date",date)
        .eq("orders.toast_excluded",false).is("orders.superseded_by",null);
      input.itemCoverageInvalidated=Boolean(!unlinked.error&&
        unlinked.count!==null&&unlinked.count!==undefined&&unlinked.count>0);
    }else{
      // PostgreSQL/PostgREST production limit is 1000 rows per query.
      // Multiple 500-row ordered pages avoid falsely certifying a truncated
      // daily order_lines result. Bounded to 5000; beyond that, fail closed.
      const linePage=(from:number,to:number)=>db.from("order_lines")
        .select("id,order_id,menu_item_id,quantity,net_sales_cents,modifiers,orders!inner(business_id,business_date)")
        .eq("orders.business_id",businessId).eq("orders.business_date",date)
        .eq("orders.toast_excluded",false).is("orders.superseded_by",null)
        .eq("voided",false).order("id",{ascending:true}).range(from,to);
      const first=await linePage(0,499);
      if(first.error)throw first.error;
      let lines=first.data??[];
      let complete=lines.length<500;
      for(let offset=500;!complete&&offset<5000;offset+=500){
        const next=await linePage(offset,offset+499);
        if(next.error)throw next.error;
        const rows=next.data??[];
        lines=[...lines,...rows];
        complete=rows.length<500;
      }
      if(!complete){
        input.itemCoverageInvalidated=true;
      }else if(lines.some(x=>x.menu_item_id===null)){
        input.itemCoverageInvalidated=true;
      }else{
        const ids=[...new Set(lines.map(x=>x.menu_item_id).filter((x):x is string=>!!x))];
        // A separate SQL aggregation is the source-completeness witness.
        // Quantity for a missing item must NEVER silently become zero.
        const lineUnits=new Map<string,number>();
        for(const line of lines)
          lineUnits.set(line.menu_item_id!, (lineUnits.get(line.menu_item_id!)??0)+Number(line.quantity));
        const quantities=[...lineUnits].map(([itemId,units])=>({itemId,units}));
        if(!reconcileItemUnitsToCanonical(quantities,coverage.soldItems)){
          input.itemCoverageInvalidated=true;
        }else{
          // Revenue attribution must ALSO reconcile every exact order total.
          const orderPage=(from:number,to:number)=>db.from("orders")
            .select("id,net_sales_cents").eq("business_id",businessId)
            .eq("toast_excluded",false).is("superseded_by",null)
            .eq("business_date",date).order("id",{ascending:true}).range(from,to);
          const firstOrders=await orderPage(0,499);
          if(firstOrders.error)throw firstOrders.error;
          let orders=firstOrders.data??[];
          let ordersComplete=orders.length<500;
          for(let offset=500;!ordersComplete&&offset<5000;offset+=500){
            const next=await orderPage(offset,offset+499);
            if(next.error)throw next.error;
            const rows=next.data??[];
            orders=[...orders,...rows];
            ordersComplete=rows.length<500;
          }
          const reconciled=reconcileAttributedItemRevenue(
            orders.map(o=>({id:o.id,netSalesCents:Number(o.net_sales_cents)})),
            lines.map(line=>({
              orderId:line.order_id,itemId:line.menu_item_id!,
              quantity:Number(line.quantity),revenueCents:Number(line.net_sales_cents),
            })),
          );
          input.itemRevenueVerified=ordersComplete&&reconciled.verified;
      const fallback=opts.costs&&ids.length?await db.from("menu_item_cost_fallbacks")
        .select("menu_item_id,cost_cents").eq("business_id",businessId)
        .in("menu_item_id",ids).eq("status","confirmed"):
        {data:[],error:null};
      if(fallback.error)throw new Error("item cost fallback unavailable");
      // recipe_lines has a COMPOSITE PK, not an id column. Paged reads must
      // use the real stable (menu_item_id,ingredient_id) sort order.
      // Unit/revenue metrics do not depend on recipes: do not let recipe
      // availability block valid POS participation or revenue evidence.
      const recipePage=(from:number,to:number)=>db.from("recipe_lines")
        .select("menu_item_id,ingredient_id,quantity")
        .in("menu_item_id",ids)
        .order("menu_item_id",{ascending:true})
        .order("ingredient_id",{ascending:true}).range(from,to);
      const firstRecipes=opts.costs&&ids.length?await recipePage(0,499):{data:[],error:null};
      if(firstRecipes.error)throw firstRecipes.error;
      let recipes=firstRecipes.data??[];
      let recipesComplete=recipes.length<500;
      for(let offset=500;!recipesComplete&&offset<5000;offset+=500){
        const next=await recipePage(offset,offset+499);
        if(next.error)throw next.error;
        const rows=next.data??[];
        recipes=[...recipes,...rows];
        recipesComplete=rows.length<500;
      }
      // Unit and net-revenue evidence may remain complete even when recipe
      // line coverage is not. Never certify the cost component from a prefix.
      input.itemCostCoverageVerified=opts.costs===true&&recipesComplete;
      const recipesByItem=new Map<string,RecipeLine[]>();
      for(const recipe of recipes){
        needed.add(recipe.ingredient_id);
        const arr=recipesByItem.get(recipe.menu_item_id)??[];
        arr.push({ingredientId:recipe.ingredient_id,quantity:Number(recipe.quantity)});
        recipesByItem.set(recipe.menu_item_id,arr);
      }
      const fallbackMap=new Map((fallback.data??[]).map(r=>[r.menu_item_id,Number(r.cost_cents)]));
      const unverifiedItems=new Set(lines.filter(line=>
        !Array.isArray(line.modifiers)||line.modifiers.length>0)
        .map(line=>line.menu_item_id));
      input.items=reconciled.items.map(({itemId,...total}):ItemEvidence=>({
        itemId,units:total.units,revenueCents:total.revenueCents,
        recipeLines:recipesByItem.get(itemId)??[],ingredientPriceMicros:{},
        ownerCostCents:fallbackMap.get(itemId)??null,
        hasUnverifiedModifiers:unverifiedItems.has(itemId),
      }));
        }
      }
    }
  }
  if(needed.size){
    const ingredients=await db.from("ingredients").select("id")
      .eq("business_id",businessId).in("id",[...needed]);
    if(ingredients.error)throw ingredients.error;
    const scopedIds=(ingredients.data??[]).map(i=>i.id);
    // Preserve Pantry's same-day correction ordering (recorded_at microseconds,
    // then id), instead of selecting whichever equal-date row PostgREST returns.
    const prices: Array<{id:string;ingredient_id:string;effective_from:string;
      recorded_at:string;cost_per_base_unit_micros:number}>=[];
    if(scopedIds.length){
      for(let offset=0;offset<5000;offset+=500){
        const page=await db.from("ingredient_prices")
          .select("id,ingredient_id,effective_from,recorded_at,cost_per_base_unit_micros")
          .in("ingredient_id",scopedIds).lte("effective_from",date)
          .order("effective_from",{ascending:false})
          .order("recorded_at",{ascending:false}).order("id",{ascending:false})
          .range(offset,offset+499);
        if(page.error)throw page.error;
        const records=page.data??[];
        prices.push(...records);
        if(records.length<500)break;
        if(offset===4500)throw new Error("ingredient price history exceeds bounded source");
      }
    }
    const priceMap:Record<string,number>={};
    for(const id of scopedIds){
      const latest=latestEffectiveIngredientPrice(prices,id,date);
      if(latest.status==="ready")priceMap[id]=latest.price.cost_per_base_unit_micros;
    }
    input.ingredientPriceMicros=priceMap;
    if(input.items)input.items=input.items.map(i=>({...i,ingredientPriceMicros:priceMap}));
  }
  if(input.items&&facts?.salesDataStatus==="actual")
    input.cogsCoverageVerified=input.itemCostCoverageVerified===true&&
      verifiedDailyCogs(input.items,facts.ingredientsCents);
  return input; // running costs intentionally not guessed: unavailable until daily source is verified
}
