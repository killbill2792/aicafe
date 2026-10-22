import "server-only";
import {createHash} from "node:crypto";
import {z} from "zod";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { formatInTimeZone } from "date-fns-tz";
import {reconcileAttributedItemRevenue,reconcileItemUnitsToCanonical} from "@/lib/calc/metrics/reconcileItemRevenue";
import { initiativeAdapters } from "@/lib/initiatives/adapters";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import { readPeriodItemSales } from "./periodItemSales.server";
import { latestEffectiveIngredientPrice } from "@/lib/calc/ingredientPriceSelection";
import { verifiedDailyCogs, type MetricDailyInput, type ItemEvidence } from "@/lib/calc/metrics/catalog";
import type { Timecard, RecipeLine } from "@/lib/calc/types";
import type { ProposeInitiative, InitiativeScope, InitiativeRow, MetricRow,
  ObservationRow, EvaluationRow } from "@/lib/initiatives/contracts";

const columns="id,business_id,owner_user_id,thread_id,kind,title,change_description,change_spec,adapter_id,starts_on,ends_on,baseline_from,baseline_to,checkin_cadence,status,locale,revision,monitor_checked_at,created_at,updated_at";
const metricColumns="id,initiative_id,role,source,metric_key,params,comparator,target_kind,target,checkin_question,checkin_audience,data_gap";

async function ownerAccess(scope:InitiativeScope){
  const db=await createServerSupabaseClient();
  const {data:{user},error}=await db.auth.getUser();
  if(error||!user||user.id!==scope.ownerUserId)throw new Error("owner authentication required");
  const member=await db.from("memberships").select("role")
    .eq("business_id",scope.businessId).eq("user_id",user.id).maybeSingle();
  if(member.error||member.data?.role!=="owner")throw new Error("owner membership required");
  return db;
}
async function serviceOwnerAccess(scope:InitiativeScope,signal?:AbortSignal) {
  const db=createAdminSupabaseClient(signal);
  const {data,error}=await db.from("memberships").select("role")
    .eq("business_id",scope.businessId).eq("user_id",scope.ownerUserId).maybeSingle();
  if(error||data?.role!=="owner")throw new Error("initiative owner membership required");
  return db;
}
export async function createOwnerInitiative(scope:InitiativeScope,input:ProposeInitiative,
  locale:"en"|"es"|"ar",requestKey:string) {
  await ownerAccess(scope);
  if(input.adapterId!==null&&!Object.hasOwn(initiativeAdapters,input.adapterId))
    throw new Error("unknown initiative adapter");
  const db=await serviceOwnerAccess(scope);
  const requiredItems=[...new Set(input.metrics.filter(m=>
    m.source==="computed"&&m.metricKey?.startsWith("item_"))
    .map(m=>String(m.params.itemId)))];
  if(requiredItems.length){
    const found=await db.from("menu_items").select("id").eq("business_id",scope.businessId)
      .in("id",requiredItems);
    if(found.error)throw found.error;
    if((found.data??[]).length!==requiredItems.length)
      throw new Error("initiative item metric must reference a business-owned item");
  }
  const rows=input.metrics.map(m=>({
    role:m.role,source:m.source,metric_key:m.metricKey,params:m.params,
    comparator:m.comparator,target_kind:m.targetKind,target:m.target,
    checkin_question:m.checkinQuestion,checkin_audience:m.checkinAudience,data_gap:m.dataGap,
  }));
  // No shipped adapter applies a change: every experiment needs an owner-confirmed
  // intervention, including the metric-only price-change suggestion adapter.
  if(input.kind==="experiment"){
    const question={en:en.Initiatives,es:es.Initiatives,ar:ar.Initiatives}[locale]
      .confirmChange.replace("{date}",input.startsOn);
    rows.push({role:"guardrail",source:"checkin",metric_key:null,
      params:{changeConfirmation:true},comparator:"gte",target_kind:"absolute",
      target:1,checkin_question:question,checkin_audience:"owner",
      data_gap:"changeRequiresOwnerConfirmation"});
  }
  const {data:id,error}=await db.rpc("create_owner_initiative_atomic",{
    p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
    p_thread_id:input.threadId,p_request_key:requestKey,
    p_proposal:{...input,locale},p_metrics:rows,
  });
  if(error||typeof id!=="string")throw error??new Error("initiative create unavailable");
  const {data, error:lookupError}=await db.from("owner_initiatives").select(columns)
    .eq("id",id).eq("business_id",scope.businessId)
    .eq("owner_user_id",scope.ownerUserId).single();
  if(lookupError||!data)throw lookupError??new Error("initiative request unavailable");
  return data as InitiativeRow;
}
export async function listOwnerInitiatives(scope:InitiativeScope,status?:string) {
  const db=await ownerAccess(scope);
  let query=db.from("owner_initiatives").select(columns)
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId);
  if(status)query=query.eq("status",status);
  const {data,error}=await query.order("created_at",{ascending:false}).limit(20);
  if(error)throw error;
  return (data??[]) as InitiativeRow[];
}
export async function readOwnerInitiative(scope:InitiativeScope,id:string,
  observation?:{metricId:string;date:string}) {
  const db=await ownerAccess(scope);
  const initiative=await db.from("owner_initiatives").select(columns).eq("id",id)
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).maybeSingle();
  if(initiative.error)throw initiative.error;
  if(!initiative.data)return null;
  const metrics=await db.from("initiative_metrics").select(metricColumns)
    .eq("initiative_id",id).limit(20);
  if(metrics.error)throw metrics.error;
  const rows=(metrics.data??[]) as MetricRow[];
  const ids=rows.map(m=>m.id);
  if(observation && !ids.includes(observation.metricId))throw new Error("initiative metric scope mismatch");
  let observationQuery=db.from("initiative_observations")
    .select("metric_id,business_date,value,coverage,source,note,revision,verified_at")
    .in("metric_id",ids).order("business_date",{ascending:false});
  if(observation)observationQuery=observationQuery.eq("metric_id",observation.metricId)
    .eq("business_date",observation.date);
  const observations=ids.length?await observationQuery.limit(observation?1:150):null;
  if(observations?.error)throw observations.error;
  const evals=await db.from("initiative_evaluations").select("*")
    .eq("initiative_id",id).order("as_of",{ascending:false}).order("created_at",{ascending:false}).limit(1);
  if(evals.error)throw evals.error;
  return {initiative:initiative.data as InitiativeRow,metrics:rows,
    observations:(observations?.data??[]) as ObservationRow[],
    evaluation:((evals.data??[])[0]??null) as EvaluationRow|null};
}
export async function activateOwnerInitiative(scope:InitiativeScope,id:string,revision:number) {
  await ownerAccess(scope);
  const db=await serviceOwnerAccess(scope);
  const metrics=await db.from("initiative_metrics").select("id,role")
    .eq("initiative_id",id).eq("role","primary").limit(1);
  if(metrics.error)throw metrics.error;
  if(!metrics.data?.length)throw new Error("initiative has no primary metric");
  const {data,error}=await db.from("owner_initiatives")
    .update({status:"active",revision:revision+1,updated_at:new Date().toISOString()})
    .eq("id",id).eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("revision",revision).eq("status","proposed").select("id,revision,status").maybeSingle();
  if(error)throw error;
  return data; // null means stale revision, wrong owner, or no longer proposed
}
export async function saveOwnerCheckin(scope:InitiativeScope,metricId:string,
  date:string,value:number|null,note:string|null,expectedRevision:number|null,operationKey:string) {
  await ownerAccess(scope);
  const db=await serviceOwnerAccess(scope);
  const metric=await db.from("initiative_metrics")
    .select("id,params,source,checkin_audience,owner_initiatives!inner(business_id,owner_user_id,status,starts_on,ends_on,checkin_cadence)")
    .eq("id",metricId).eq("source","checkin").eq("checkin_audience","owner")
    .eq("owner_initiatives.business_id",scope.businessId)
    .eq("owner_initiatives.owner_user_id",scope.ownerUserId)
    .eq("owner_initiatives.status","active").maybeSingle();
  if(metric.error)throw metric.error;
  if(!metric.data)throw new Error("owner check-in not available");
  const business=await db.from("businesses").select("timezone").eq("id",scope.businessId).single();
  if(business.error||!business.data)throw new Error("initiative timezone unavailable");
  const today=formatInTimeZone(new Date(),business.data.timezone||"America/Los_Angeles","yyyy-MM-dd");
  const parent=metric.data.owner_initiatives as unknown as {
    starts_on:string;ends_on:string;checkin_cadence:"daily"|"every_3_days"|"weekly"|"end_only";
  };
  const delta=Math.round((Date.parse(date+"T12:00:00Z")-Date.parse(parent.starts_on+"T12:00:00Z"))/86400000);
  const eligible=metric.data.params?.changeConfirmation===true ? date===parent.starts_on :
    parent.checkin_cadence==="daily"||
    (parent.checkin_cadence==="every_3_days"&&delta%3===0)||
    (parent.checkin_cadence==="weekly"&&delta%7===0)||
    (parent.checkin_cadence==="end_only"&&date===parent.ends_on);
  if(!Number.isInteger(delta)||!eligible||date<parent.starts_on||date>parent.ends_on||date>today)
    throw new Error("check-in date outside approved schedule");
  const {data,error}=await db.rpc("record_owner_initiative_checkin_atomic",{
    p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
    p_metric_id:metricId,p_date:date,p_value:value,p_note:note,
    p_expected_revision:expectedRevision,p_operation_key:operationKey,
  });
  if(error)throw error;
  return z.strictObject({
    created:z.boolean(),corrected:z.boolean(),revision:z.number().int().positive(),
  }).parse(data);
}
export async function listMonitorBatch(signal?:AbortSignal) {
  const db=createAdminSupabaseClient(signal);
  const {data,error}=await db.from("owner_initiatives").select(columns)
    .eq("status","active").or("monitor_lease_until.is.null,monitor_lease_until.lt."+new Date().toISOString())
    .order("monitor_checked_at",{ascending:true,nullsFirst:true})
    .order("id",{ascending:true}).limit(100);
  if(error)throw error;
  return (data??[]) as InitiativeRow[];
}
export async function readMonitorGraph(initiative:InitiativeRow,signal?:AbortSignal) {
  const db=await serviceOwnerAccess({businessId:initiative.business_id,ownerUserId:initiative.owner_user_id},signal);
  const [metricResult,businessResult,evaluationResult,revisionResult]=await Promise.all([
    db.from("initiative_metrics").select(metricColumns).eq("initiative_id",initiative.id),
    db.from("businesses").select("timezone").eq("id",initiative.business_id).single(),
    db.from("initiative_evaluations").select("*").eq("initiative_id",initiative.id)
      .order("as_of",{ascending:false}).order("created_at",{ascending:false}).limit(1),
    db.from("owner_initiatives").select("evidence_revision")
      .eq("id",initiative.id).eq("business_id",initiative.business_id).single(),
  ]);
  if(metricResult.error||businessResult.error||evaluationResult.error||revisionResult.error||
    !revisionResult.data||!businessResult.data)
    throw new Error("initiative monitor source unavailable");
  const metrics=(metricResult.data??[]) as MetricRow[];
  const observations:ObservationRow[]=[];
  // PostgREST production max_rows is 1,000. Limit(2500) is NOT pagination.
  // Stable metric/day ordering and bounded pages avoid silent evidence loss.
  if(metrics.length){
    for(let offset=0;offset<2500;offset+=500){
      const page=await db.from("initiative_observations")
        .select("metric_id,business_date,value,coverage,source,note,revision,verified_at")
        .in("metric_id",metrics.map(m=>m.id))
        .gte("business_date",initiative.baseline_from)
        .lte("business_date",initiative.ends_on)
        .order("business_date",{ascending:true}).order("metric_id",{ascending:true})
        .range(offset,offset+499);
      if(page.error)throw page.error;
      const rows=(page.data??[]) as ObservationRow[];
      observations.push(...rows);
      if(rows.length<500)break;
      if(offset===2000)throw new Error("initiative observation coverage exceeds cap");
    }
  }
  return {metrics,observations,evidenceRevision:Number(revisionResult.data.evidence_revision),
    timezone:businessResult.data.timezone||"America/Los_Angeles",
    latest:((evaluationResult.data??[])[0]??null) as EvaluationRow|null};
}
export async function claimMonitorInitiative(initiative:InitiativeRow,token:string,
  signal?:AbortSignal):Promise<InitiativeRow|null> {
  const db=createAdminSupabaseClient(signal);
  const {data,error}=await db.rpc("claim_owner_initiative_monitor",{
    p_id:initiative.id,p_revision:initiative.revision,p_token:token,
  });
  if(error)throw error;
  return typeof data==="number"?{...initiative,revision:data}:null;
}
export async function releaseMonitorInitiative(id:string,token:string,completed:boolean,
  evidenceRevision:number,signal?:AbortSignal) {
  const db=createAdminSupabaseClient(signal);
  const {error}=await db.rpc("release_owner_initiative_monitor",{
    p_id:id,p_token:token,p_completed:completed,
    p_expected_evidence_revision:evidenceRevision,
  });
  if(error)throw error;
}
/** Atomic source observation and lease test. No read/update race or stale worker writes. */
export async function persistMetricObservation(scope:InitiativeScope,initiativeId:string,
  leaseToken:string,row:ObservationRow,allowInvalidation=false,signal?:AbortSignal) {
  const db=await serviceOwnerAccess(scope,signal);
  const {data,error}=await db.rpc("write_owner_initiative_monitor_observation",{
    p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
    p_initiative_id:initiativeId,p_token:leaseToken,
    p_metric_id:row.metric_id,p_date:row.business_date,p_value:row.value,
    p_coverage:row.coverage,p_note:row.note,p_allow_invalidation:allowInvalidation,
  });
  if(error)throw error;
  return data===true;
}
export async function persistInitiativeEvaluation(scope:InitiativeScope,initiativeId:string,
  asOf:string,status:string,recommendation:string,results:Record<string,unknown>,
  inputs:Record<string,unknown>,transitionKey:string,leaseToken:string,
  signal?:AbortSignal) {
  const db=await serviceOwnerAccess(scope,signal);
  const canonical=Object.entries(results).sort(([a],[b])=>a.localeCompare(b));
  const digest=createHash("sha256").update(JSON.stringify({
    asOf,status,recommendation,results:canonical,inputs,transitionKey,
  })).digest("hex");
  const {data,error}=await db.rpc("write_owner_initiative_monitor_evaluation",{
    p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
    p_initiative_id:initiativeId,p_token:leaseToken,
    p_as_of:asOf,p_status:status,p_recommendation:recommendation,
    p_results:results,p_inputs:inputs,p_transition_key:transitionKey,p_digest:digest,
  });
  if(error)throw error;
  return data===true;
}
export async function readMetricDay(businessId:string,date:string,
  opts:{items:boolean;hours:boolean;ingredientIds:string[];itemIds?:string[]},
  signal?:AbortSignal):Promise<MetricDailyInput> {
  const db=createAdminSupabaseClient(signal);
  const day=await db.from("daily_rollups").select(
    "business_date,net_sales_cents,orders_count,drinks_count,ingredients_cents,staff_wages_cents,staff_tax_cents,staff_tax_status,sales_data_status,card_fees_cents,voids_cents"
  ).eq("business_id",businessId).eq("business_date",date).maybeSingle();
  if(day.error)throw day.error;
  const facts=day.data?{
    date:day.data.business_date,netSalesCents:Number(day.data.net_sales_cents),
    ordersCount:Number(day.data.orders_count),drinksCount:Number(day.data.drinks_count),
    ingredientsCents:Number(day.data.ingredients_cents),wagesCents:Number(day.data.staff_wages_cents),
    staffTaxCents:Number(day.data.staff_tax_cents),staffTaxStatus:day.data.staff_tax_status,
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
  const orderCount=Number(source.data.order_count);
  const netSourceCents=Number(source.data.net_sales_cents);
  const syntheticCount=Number(source.data.synthetic_count);
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
        clockIn:t.clock_in,clockOut:t.clock_out,hourlyWageCents:Number(t.hourly_wage_cents),
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
        .eq("orders.business_id",businessId).eq("orders.business_date",date);
      input.itemCoverageInvalidated=Boolean(!unlinked.error&&
        unlinked.count!==null&&unlinked.count!==undefined&&unlinked.count>0);
    }else{
      // PostgreSQL/PostgREST production limit is 1000 rows per query.
      // Multiple 500-row ordered pages avoid falsely certifying a truncated
      // daily order_lines result. Bounded to 5000; beyond that, fail closed.
      const linePage=(from:number,to:number)=>db.from("order_lines")
        .select("id,order_id,menu_item_id,quantity,net_sales_cents,modifiers,orders!inner(business_id,business_date)")
        .eq("orders.business_id",businessId).eq("orders.business_date",date)
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
      const fallback=ids.length?await db.from("menu_item_cost_fallbacks")
        .select("menu_item_id,cost_cents").eq("business_id",businessId)
        .in("menu_item_id",ids).eq("status","confirmed"):
        {data:[],error:null};
      if(fallback.error)throw new Error("item cost fallback unavailable");
      const recipePage=(from:number,to:number)=>db.from("recipe_lines")
        .select("id,menu_item_id,ingredient_id,quantity")
        .in("menu_item_id",ids).order("id",{ascending:true}).range(from,to);
      const firstRecipes=ids.length?await recipePage(0,499):{data:[],error:null};
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
      input.itemCostCoverageVerified=recipesComplete;
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
