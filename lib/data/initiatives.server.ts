import "server-only";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { formatInTimeZone } from "date-fns-tz";
import { initiativeAdapters } from "@/lib/initiatives/adapters";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import { readPeriodItemSales } from "./periodItemSales.server";
import type { MetricDailyInput, ItemEvidence } from "@/lib/calc/metrics/catalog";
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
async function serviceOwnerAccess(scope:InitiativeScope) {
  const db=createAdminSupabaseClient();
  const {data,error}=await db.from("memberships").select("role")
    .eq("business_id",scope.businessId).eq("user_id",scope.ownerUserId).maybeSingle();
  if(error||data?.role!=="owner")throw new Error("initiative owner membership required");
  return db;
}
export async function createOwnerInitiative(scope:InitiativeScope,input:ProposeInitiative,locale:"en"|"es"|"ar") {
  await ownerAccess(scope);
  if(input.adapterId!==null && !Object.hasOwn(initiativeAdapters,input.adapterId))
    throw new Error("unknown initiative adapter");
  const db=await serviceOwnerAccess(scope);
  const thread=await db.from("ai_threads").select("id").eq("id",input.threadId)
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).maybeSingle();
  if(thread.error||!thread.data)throw new Error("initiative thread access denied");
  const {data,error}=await db.from("owner_initiatives").insert({
    business_id:scope.businessId,owner_user_id:scope.ownerUserId,thread_id:input.threadId,
    kind:input.kind,title:input.title,change_description:input.changeDescription,
    change_spec:input.changeSpec,adapter_id:input.adapterId,starts_on:input.startsOn,
    ends_on:input.endsOn,baseline_from:input.baselineFrom,baseline_to:input.baselineTo,
    checkin_cadence:input.checkinCadence,status:"proposed",locale,
  }).select(columns).single();
  if(error||!data)throw error??new Error("initiative insert failed");
  const rows=input.metrics.map(m=>({
    initiative_id:data.id,role:m.role,source:m.source,metric_key:m.metricKey,
    params:m.params,comparator:m.comparator,target_kind:m.targetKind,target:m.target,
    checkin_question:m.checkinQuestion,checkin_audience:m.checkinAudience,data_gap:m.dataGap,
  }));
  if(input.kind==="experiment"){
    // The metric-only price adapter does NOT apply a change. All experiments
    // require the owner to confirm that the intervention actually occurred.
    const question={en:en.Initiatives,es:es.Initiatives,ar:ar.Initiatives}[locale]
      .confirmChange.replace("{date}",input.startsOn);
    rows.push({
      initiative_id:data.id,role:"guardrail",source:"checkin",metric_key:null,
      params:{changeConfirmation:true},comparator:"gte",target_kind:"absolute",
      target:1,checkin_question:question,checkin_audience:"owner",
      data_gap:"changeRequiresOwnerConfirmation",
    });
  }
  const inserted=await db.from("initiative_metrics").insert(rows);
  if(inserted.error) {
    const cleanup=await db.from("owner_initiatives").delete().eq("id",data.id)
      .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId);
    if(cleanup.error)throw new Error("initiative creation requires cleanup");
    throw inserted.error;
  }
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
export async function readOwnerInitiative(scope:InitiativeScope,id:string) {
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
  const observations=ids.length?await db.from("initiative_observations")
    .select("metric_id,business_date,value,coverage,source,note")
    .in("metric_id",ids).order("business_date",{ascending:false}).limit(150):null;
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
  date:string,value:number|null,note:string|null) {
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
  const next={metric_id:metricId,business_date:date,value,coverage:value===null?0:1,
    source:"owner_checkin",note};
  const prior=await db.from("initiative_observations")
    .select("value,note,source").eq("metric_id",metricId).eq("business_date",date).maybeSingle();
  if(prior.error)throw prior.error;
  if(prior.data?.source==="staff_checkin")throw new Error("owner cannot replace staff evidence");
  if(prior.data?.value===value&&prior.data?.note===note)return {created:false,corrected:false};
  // Unique metric/day constraint prevents duplicate inserts. Authorized changed
  // answers can be corrected, including note-only -> numeric completion.
  const {error}=await db.from("initiative_observations").upsert(next,{
    onConflict:"metric_id,business_date",
  });
  if(error)throw error;
  return {created:!prior.data,corrected:!!prior.data};
}
export async function listMonitorBatch() {
  const db=createAdminSupabaseClient();
  const {data,error}=await db.from("owner_initiatives").select(columns)
    .eq("status","active").order("monitor_checked_at",{ascending:true,nullsFirst:true})
    .order("id",{ascending:true}).limit(100);
  if(error)throw error;
  return (data??[]) as InitiativeRow[];
}
export async function readMonitorGraph(initiative:InitiativeRow) {
  const db=await serviceOwnerAccess({businessId:initiative.business_id,ownerUserId:initiative.owner_user_id});
  const [metricResult,businessResult,evaluationResult]=await Promise.all([
    db.from("initiative_metrics").select(metricColumns).eq("initiative_id",initiative.id),
    db.from("businesses").select("timezone").eq("id",initiative.business_id).single(),
    db.from("initiative_evaluations").select("*").eq("initiative_id",initiative.id)
      .order("as_of",{ascending:false}).order("created_at",{ascending:false}).limit(1),
  ]);
  if(metricResult.error||businessResult.error||evaluationResult.error||!businessResult.data)
    throw new Error("initiative monitor source unavailable");
  const metrics=(metricResult.data??[]) as MetricRow[];
  const observations=metrics.length?await db.from("initiative_observations")
    .select("metric_id,business_date,value,coverage,source,note")
    .in("metric_id",metrics.map(m=>m.id))
    .gte("business_date",initiative.baseline_from)
    .lte("business_date",initiative.ends_on).limit(2500):null;
  if(observations?.error)throw observations.error;
  return {metrics,observations:(observations?.data??[]) as ObservationRow[],
    timezone:businessResult.data.timezone||"America/Los_Angeles",
    latest:((evaluationResult.data??[])[0]??null) as EvaluationRow|null};
}
export async function persistMetricObservation(scope:InitiativeScope,row:ObservationRow) {
  const db=await serviceOwnerAccess(scope);
  // A completed check-in is never overwritten by a computed sample.
  const {data:existing,error:readError}=await db.from("initiative_observations")
    .select("coverage,source,value").eq("metric_id",row.metric_id)
    .eq("business_date",row.business_date).maybeSingle();
  if(readError)throw readError;
  if(existing&&(existing.source!=="computed"||existing.coverage>=row.coverage))return false;
  const {error}=await db.from("initiative_observations").upsert(row,{onConflict:"metric_id,business_date"});
  if(error)throw error;
  return true;
}
export async function persistInitiativeEvaluation(scope:InitiativeScope,initiativeId:string,
  asOf:string,status:string,recommendation:string,results:Record<string,unknown>) {
  const db=await serviceOwnerAccess(scope);
  const digest=[status,recommendation].join(":");
  const {data,error}=await db.from("initiative_evaluations").upsert({
    initiative_id:initiativeId,as_of:asOf,status,recommendation,results,digest,
  },{onConflict:"initiative_id,digest",ignoreDuplicates:true}).select("id").maybeSingle();
  if(error)throw error;
  return data!==null;
}
export async function rotateInitiative(initiative:InitiativeRow,completed:boolean) {
  const db=createAdminSupabaseClient();
  const {error}=await db.from("owner_initiatives")
    .update({monitor_checked_at:new Date().toISOString(),
      ...(completed?{status:"completed"}:{}),
      updated_at:new Date().toISOString(),revision:initiative.revision+1})
    .eq("id",initiative.id).eq("business_id",initiative.business_id)
    .eq("owner_user_id",initiative.owner_user_id).eq("revision",initiative.revision)
    .eq("status","active");
  if(error)throw error;
}
export async function readMetricDay(businessId:string,date:string,
  opts:{items:boolean;hours:boolean;ingredientIds:string[]}):Promise<MetricDailyInput> {
  const db=createAdminSupabaseClient();
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
  if(opts.hours){
    const [orders,timecards,timezone]=await Promise.all([
      db.from("orders").select("closed_at,net_sales_cents").eq("business_id",businessId)
        .eq("business_date",date).limit(1001),
      db.from("timecards").select("clock_in,clock_out,hourly_wage_cents,breaks")
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
      }));
      input.timezone=timezone.data?.timezone;
    }
  }
  const needed=new Set(opts.ingredientIds);
  if(opts.items){
    // Item economics cannot be inferred from a covered daily total alone.
    // Canonical POS provenance first proves exact item participation.
    const coverage=await readPeriodItemSales(db,businessId,{from:date,to:date});
    if(coverage.covered){
    const lines=await db.from("order_lines")
      .select("order_id,menu_item_id,quantity,net_sales_cents,orders!inner(business_id,business_date)")
      .eq("orders.business_id",businessId).eq("orders.business_date",date)
      .eq("voided",false).limit(1001);
    if(lines.error)throw lines.error;
    if((lines.data??[]).length<=1000 && !(lines.data??[]).some(x=>x.menu_item_id===null)){
      const ids=[...new Set((lines.data??[]).map(x=>x.menu_item_id).filter((x):x is string=>!!x))];
      // Order-level discounts/refunds cannot be assigned to items by assumption.
      const orders=await db.from("orders").select("id,net_sales_cents")
        .eq("business_id",businessId).eq("business_date",date).limit(1001);
      if(orders.error)throw orders.error;
      const attributed=new Map<string,number>();
      for(const line of lines.data??[])
        attributed.set(line.order_id,(attributed.get(line.order_id)??0)+Number(line.net_sales_cents));
      input.itemRevenueVerified=(orders.data??[]).length<=1000&&
        (orders.data??[]).length===attributed.size&&
        (orders.data??[]).every(o=>attributed.get(o.id)===Number(o.net_sales_cents));
      const totals=new Map<string,{units:number;revenueCents:number}>();
      for(const line of lines.data??[]){
        const current=totals.get(line.menu_item_id!)??{units:0,revenueCents:0};
        current.units+=Number(line.quantity);current.revenueCents+=Number(line.net_sales_cents);
        totals.set(line.menu_item_id!,current);
      }
      const [fallback,recipes]=await Promise.all([
        ids.length?db.from("menu_item_cost_fallbacks").select("menu_item_id,cost_cents").eq("business_id",businessId).in("menu_item_id",ids)
          .eq("status","confirmed"):Promise.resolve({data:[],error:null}),
        ids.length?db.from("recipe_lines").select("menu_item_id,ingredient_id,quantity").in("menu_item_id",ids):
          Promise.resolve({data:[],error:null}),
      ]);
      if(fallback.error||recipes.error)throw new Error("item cost sources unavailable");
      const recipesByItem=new Map<string,RecipeLine[]>();
      for(const recipe of recipes.data??[]){
        needed.add(recipe.ingredient_id);
        const arr=recipesByItem.get(recipe.menu_item_id)??[];
        arr.push({ingredientId:recipe.ingredient_id,quantity:Number(recipe.quantity)});
        recipesByItem.set(recipe.menu_item_id,arr);
      }
      const fallbackMap=new Map((fallback.data??[]).map(r=>[r.menu_item_id,Number(r.cost_cents)]));
      input.items=[...totals].map(([itemId,total]):ItemEvidence=>({
        itemId,units:total.units,revenueCents:total.revenueCents,
        recipeLines:recipesByItem.get(itemId)??[],ingredientPriceMicros:{},
        ownerCostCents:fallbackMap.get(itemId)??null,
      }));
    }
    }
  }
  if(needed.size){
    const ingredients=await db.from("ingredients").select("id")
      .eq("business_id",businessId).in("id",[...needed]);
    if(ingredients.error)throw ingredients.error;
    const scopedIds=(ingredients.data??[]).map(i=>i.id);
    const priceResult=scopedIds.length?await db.from("ingredient_prices")
      .select("ingredient_id,effective_from,cost_per_base_unit_micros")
      .in("ingredient_id",scopedIds).lte("effective_from",date)
      .order("effective_from",{ascending:false}).limit(1000):null;
    if(priceResult?.error)throw priceResult.error;
    const priceMap:Record<string,number>={};
    for(const r of priceResult?.data??[])
      if(priceMap[r.ingredient_id]===undefined)
        priceMap[r.ingredient_id]=Number(r.cost_per_base_unit_micros);
    input.ingredientPriceMicros=priceMap;
    if(input.items)input.items=input.items.map(i=>({...i,ingredientPriceMicros:priceMap}));
  }
  return input; // running costs intentionally not guessed: unavailable until daily source is verified
}
