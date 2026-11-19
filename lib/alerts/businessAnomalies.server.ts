import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {supervisorHistoricalReaders} from "@/lib/ai/supervisorReads.server";
import {supervisorFactReaders} from "@/lib/ai/supervisorFacts.server";
import {agentSourceReaders} from "@/lib/data/agentReadSources.server";
import {readUsageVariance} from "@/lib/data/usageVariance.server";
import {readCanonicalView} from "@/lib/data/canonical/reads.server";
import {projectInventoryEvidence} from "@/lib/calc/inventoryEvidence";
import {readSupplierPurchasingEvidence} from "@/lib/data/supplierPurchasing.server";
import {packBaseQuantity,type BaseUnit} from "@/lib/calc/recipeUnits";
import {readDailyFacts} from "@/lib/data/dailyFacts.server";
import {getMenuItemsForEdit} from "@/lib/data/getMenuItemsForEdit";
import {createHash} from "node:crypto";
import {evaluateRecipeCost,isEarlyClockIn} from "@/lib/calc";
import {fromZonedTime,formatInTimeZone} from "date-fns-tz";
import {readSavedTodayLive,TODAY_LIVE_FRESH_MS} from "@/lib/data/todayLive.server";
import {readTimecardsForInterval} from "@/lib/data/timecardsForInterval.server";
import {hourlyStaffPressure} from "./hourlyStaffPressure";
import {posFactReaders} from "@/lib/data/posFactReaders.server";
import {compareLiveEventSales,indexHourlyRevenue} from "@/lib/metrics/core/eventReadiness";
import {getBusinessSnapshotFromDb} from "@/lib/data/snapshot.server";
import {cafeStateFromSnapshot} from "@/lib/operating/cafeState";
import {verifiedPeriodDays,verifiedRecoveryRatio,comparableRecoveryPeriods} from "./costRecoveryComparison";
import type {BusinessSignal} from "./businessSignals";

type Observation={family:BusinessSignal;subject:string;current:number;previous:number;unit:string;active:boolean;asOf:string;from:string;to:string};
const day=(date:string,offset:number)=>new Date(Date.parse(date+"T12:00:00Z")+offset*86400000).toISOString().slice(0,10);
const clean=(q:{missingInputs:string[];estimatedInputs:string[];staleInputs:string[]})=>!q.missingInputs.length&&!q.estimatedInputs.length&&!q.staleInputs.length;
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const materiallyChanged=(a:number,b:number)=>b>0&&Math.abs(a-b)/b>=0.20;
/** A certified zero baseline can establish a first material increase, without dividing by zero. */
export function compareCheckedRefunds(current:number|null,previous:number|null,from:string,to:string):Observation|null{
 if(!finite(current)||!finite(previous)||current<0||previous<0)return null;
 if(previous===0)return {family:"order_refund_rise",subject:"cafe",current,previous,unit:"order_date_refund_cents",active:current>0,from,to,asOf:to};
 return compareBusinessFacts("order_refund_rise","cafe",current,previous,"order_date_refund_cents",from,to,to,"up");
}
export function compareBusinessFacts(family:BusinessSignal,subject:string,current:number|null,previous:number|null,unit:string,from:string,to:string,asOf:string,direction:"up"|"down"|"both"="both"):Observation|null{
 if(!finite(current)||!finite(previous)||previous<0||current<0)return null;
 if(previous===0&&current!==0)return null;
 return {family,subject,current,previous,unit,from,to,asOf,active:materiallyChanged(current,previous)&&(direction==="both"||(direction==="up"?current>previous:current<previous))};
}
const fact=(family:BusinessSignal,subject:string,current:number,previous:number,unit:string,active:boolean,from:string,to:string):Observation=>({family,subject,current,previous,unit,active,asOf:to,from,to});
/** One scheduled consumer of existing canonical readers. Compare closed, equal-length weeks;
 * absence and estimated wages are not actuals. Threshold is a review heuristic, not a loss claim.
 * Every family is isolated so a failing data source cannot halt other business work. */
export async function refreshBusinessAnomalies(db:SupabaseClient,businessId:string,today:string,timezone:string,now:Date=new Date()):Promise<number>{
 const to=day(today,-1),from=day(today,-7),old={from:day(today,-14),to:day(today,-8)},recent={from,to};
 const historical=supervisorHistoricalReaders(db,businessId),facts=supervisorFactReaders(db,businessId),ingredients=agentSourceReaders(db,businessId);
 let created=0;
 async function persist(o:Observation|null){
  if(!o)return;
  const {data,error}=await db.rpc("supervisor_reconcile_business_anomaly",{p_business_id:businessId,p_key:o.family+":"+o.subject,p_active:o.active,
   p_payload:{...o,dedupeKey:o.family+":"+o.subject,quality:o.family==="data_gap"||o.family==="missed_clock_evidence"?"missing":["stockout_risk","live_sales_decline","live_sales_growth","overstaffed_hour"].includes(o.family)?"partial":"verified",severity:o.family==="stock_shortage"?"high":"warning"}});
  if(error)throw error;
  if(data===true)created++;
 }
 async function gap(subject:string,missing:boolean){
  await persist(fact("data_gap",subject,missing?1:0,0,"coverage",missing,"",""));
 }
 const work=[
  async()=>{
   const captured=await db.rpc("supervisor_capture_catalog_cost_baseline",{p_business_id:businessId});
   if(captured.error)throw captured.error;
  },
  async()=>{
   const [a,b]=await Promise.all([historical.salesTrend(businessId,recent),historical.salesTrend(businessId,old)]);
   const valid=a.available&&b.available&&clean(a.quality)&&clean(b.quality)&&a.value.length===7&&b.value.length===7;
   await gap("sales_coverage",!valid);
   if(!valid||!a.available||!b.available)return;
   const sum=(rows:typeof a.value)=>rows.reduce((s,d)=>s+d.netSalesCents,0);
   for(const [family,direction] of [["sales_decline","down"],["sales_growth","up"]] as const)await persist(compareBusinessFacts(family,"cafe",sum(a.value),sum(b.value),"cents",from,to,to,direction));
  },
  async()=>{
   const [a,b]=await Promise.all([readDailyFacts(db,businessId,from,to),readDailyFacts(db,businessId,old.from,old.to)]);
   const wages=(rows:typeof a)=>rows.length===7&&new Set(rows.map(d=>d.date)).size===7&&rows.every(d=>d.laborWageStatus==="actual"&&finite(d.wagesCents))?rows.reduce((s,d)=>s+d.wagesCents!,0):null;
   const aw=wages(a),bw=wages(b);
   await gap("actual_wage_coverage",aw===null||bw===null);
   await persist(compareBusinessFacts("labor_cost","cafe",aw,bw,"cents",from,to,to));
  },
  async()=>{
   const [a,b]=await Promise.all([facts.recordedExpenses(businessId,recent),facts.recordedExpenses(businessId,old)]);
   await gap("expense_coverage",!(a.available&&b.available&&clean(a.quality)&&clean(b.quality)));
   if(a.available&&b.available&&clean(a.quality)&&clean(b.quality))await persist(compareBusinessFacts("recorded_expense_rise","cafe",a.value.totalCents,b.value.totalCents,"cents",from,to,to,"up"));
  },
  async()=>{
   const [a,b]=await Promise.all([ingredients.ingredientCosts(businessId,today,null,500),ingredients.ingredientCosts(businessId,old.to,null,500)]);
   if([...a.quality.missingInputs,...b.quality.missingInputs].some(s=>/Truncated/.test(s)))throw Error("ingredient_history_truncated");
   const prev=new Map(b.value.items.map(x=>[x.id,x]));
   for(const item of a.value.items){const before=prev.get(item.id);
    if(before&&before.baseUnit===item.baseUnit)await persist(compareBusinessFacts("ingredient_cost",item.id,item.costPerBaseUnitMicros,before.costPerBaseUnitMicros,"micros_per_"+item.baseUnit,old.to,today,today,"up"));
   }
   await gap("ingredient_prices",a.quality.missingInputs.includes("ingredientPricesMissing"));
   // Same CURRENT size recipe priced at two observed ingredient-price dates.
   // This is not a historical recipe or historical realized profit claim.
   const beforePrices=Object.fromEntries(b.value.items.filter(i=>finite(i.costPerBaseUnitMicros)).map(i=>[i.id,i.costPerBaseUnitMicros!]));
   const afterPrices=Object.fromEntries(a.value.items.filter(i=>finite(i.costPerBaseUnitMicros)).map(i=>[i.id,i.costPerBaseUnitMicros!]));
   const {items}=await getMenuItemsForEdit({client:db,businessId});
   const [sales,prior]=await Promise.all([facts.productSales(businessId,recent),db.rpc("supervisor_prior_recipe_evidence",{p_business_id:businessId,p_as_of:old.to})]);
   if(prior.error)throw prior.error;
   const priorRows=Array.isArray(prior.data)?prior.data as Array<{product_id:string;ingredient_id:string;quantity:number;price_micros:number|null}>:[];
   let historyMissing=false;
   const ranked:Array<{id:string;contribution:number}>=[];
   for(const item of items.filter(i=>i.active&&i.costSource==="recipe"&&i.priceCents>0)){
    const rows=priorRows.filter(r=>r.product_id===item.id);
    const observed=rows.length>0&&rows.every(r=>finite(r.quantity)&&r.quantity>0&&finite(r.price_micros)&&r.price_micros!>0);
    if(!observed)historyMissing=true;
    const before=observed?evaluateRecipeCost(rows.map(r=>({ingredientId:r.ingredient_id,quantity:r.quantity})),Object.fromEntries(rows.map(r=>[r.ingredient_id,r.price_micros!]))):evaluateRecipeCost(item.recipe,beforePrices);
    const after=evaluateRecipeCost(item.recipe,afterPrices);
    if(after.status!=="READY"||after.costCents===null)continue;
    const marginAfter=item.priceCents-after.costCents;
    if(before.status==="READY"&&before.costCents!==null){
     const unit=observed?"cents_per_observed_recipe":"cents_per_current_recipe";
     const cost=compareBusinessFacts("product_cost",item.id,after.costCents,before.costCents,unit,old.to,today,today);
     // Current-configuration sensitivity is useful positive review evidence, but
     // cannot close a previously observed recipe incident without actual history.
     if(observed||cost?.active)await persist(cost);
     const marginBefore=item.priceCents-before.costCents;
     const active=marginBefore>0&&marginAfter<=marginBefore*.8;
     if(marginBefore>0&&(observed||active))await persist(fact("product_contribution",item.id,marginAfter,marginBefore,unit,active,old.to,today));
    }
    const sold=sales.available&&clean(sales.quality)?sales.value.find(v=>v.id===item.id)?.units:null;
    if(finite(sold)&&sold>0&&marginAfter>0)ranked.push({id:item.id,contribution:marginAfter*sold});
   }
   await gap("product_recipe_history",historyMissing);
   const total=ranked.reduce((s,x)=>s+x.contribution,0);
   if(sales.available&&clean(sales.quality)&&sales.value.filter(v=>v.units>0).every(v=>ranked.some(x=>x.id===v.id))&&ranked.length>=5&&total>0)for(const row of ranked)
    await persist(fact("high_contribution",row.id,row.contribution,total,"current_recipe_contribution_cents",row.contribution/total>=.25,from,to));
  },
  async()=>{
   const raw=await readCanonicalView(db,businessId,"cv_inventory",{dateFrom:to,dateTo:today},101);
   if(raw.error||raw.truncated||raw.rows.length>100)throw Error("inventory_unavailable");
   const stock=projectInventoryEvidence(raw.rows,100);
   await gap("stock_counts",!stock.rows.some(s=>s.source==="app"&&(s.source_as_of===to||s.source_as_of===today)&&s.quantity!==null));
   const counts=new Map<string,typeof stock.rows[number]>();
   for(const count of stock.rows.filter(s=>s.source==="app"&&s.ingredient_id&&s.quantity!==null&&s.quantity_unit&&(s.source_as_of===to||s.source_as_of===today)).sort((a,b)=>String(b.source_as_of).localeCompare(String(a.source_as_of)))){
    if(!counts.has(count.ingredient_id!))counts.set(count.ingredient_id!,count);
   }
   // A fresh physical count is independent of whether recipe/sales usage can be calculated.
   for(const [id,count] of counts)await persist(fact("stock_shortage",id,count.quantity!,0,count.quantity_unit!,count.quantity===0,String(count.source_as_of),String(count.source_as_of)));
   const usage=await readUsageVariance(recent,{client:db,businessId});
   for(const row of usage.rows){
    if(!row.missing.length&&finite(row.expected)&&finite(row.actual)&&row.status!==null)
     await persist(fact("consumption_variance",row.ingredientId,row.actual,row.expected,row.unit,row.status==="over",from,to));
    const count=stock.rows.filter(s=>s.source==="app"&&s.ingredient_id===row.ingredientId&&(s.source_as_of===to||s.source_as_of===today)&&s.quantity!==null&&s.quantity_unit===row.unit).sort((a,b)=>String(b.source_as_of).localeCompare(String(a.source_as_of)))[0];
    if(!count||count.quantity===null)continue;
    if(usage.provenance.coverage==="complete"&&finite(row.expected)&&row.expected>0&&!row.missing.some(m=>/sales|recipe|modifier|unmapped/i.test(m)))
     await persist(fact("stockout_risk",row.ingredientId,count.quantity,row.expected/7,row.unit,count.quantity<row.expected/7,from,to));
   }
  },
  async()=>{
   const {quotes,ingredients:catalog,currency,truncated}=await readSupplierPurchasingEvidence(db,businessId);
   if(truncated)throw Error("supplier_quote_history_truncated");
   const groups=new Map<string,typeof quotes>();
   for(const q of quotes){
    if(!q.ingredient_id||q.currency_code!==currency||!q.quoted_on||q.quoted_on>today)continue;
    const key=q.ingredient_id+":"+createHash("sha256").update(q.supplier_name.normalize("NFKC").trim().toLowerCase()).digest("hex").slice(0,24);
    groups.set(key,[...(groups.get(key)??[]),q]);
   }
   for(const [key,rows] of groups){
    const sorted=rows.sort((a,b)=>b.quoted_on.localeCompare(a.quoted_on));
    const a=sorted[0],b=sorted.find(q=>q.quoted_on<a.quoted_on&&q.package_unit===a.package_unit&&q.package_count===a.package_count);
    if((a.valid_until?a.valid_until<today:Date.parse(today)-Date.parse(a.quoted_on)>30*86400000)||a.available_status!=="confirmed"||!a.available_checked_at||a.available_checked_at>today||Date.parse(today)-Date.parse(a.available_checked_at)>7*86400000||a.source_kind==="public_listing"||b?.source_kind==="public_listing")continue;
    const item=catalog.find(i=>i.id===a.ingredient_id);
    if(!b||!item)continue;
    const normalized=(q:typeof a)=>{const pack=packBaseQuantity(Number(q.package_count),q.package_unit==="liter"?"l":q.package_unit,item.base_unit as BaseUnit);return pack&&q.price_cents>0?q.price_cents/pack:null;};
    // Subject includes the canonical ingredient UUID; supplier identity stays in the read evidence.
    await persist(compareBusinessFacts("supplier_quote",key,normalized(a),normalized(b),"cents_per_"+item.base_unit,b.quoted_on,a.quoted_on,a.quoted_on,"up"));
   }
  },
 ];
 work.push(async()=>{
  const [a,b,sa,sb]=await Promise.all([getBusinessSnapshotFromDb(db,businessId,recent),getBusinessSnapshotFromDb(db,businessId,old),historical.salesTrend(businessId,recent),historical.salesTrend(businessId,old)]);
  const after=cafeStateFromSnapshot(a,recent).profitability,before=cafeStateFromSnapshot(b,old).profitability;
  const valid=after.available&&before.available&&clean(after.quality)&&clean(before.quality)&&
   after.value.netSalesCents>0&&before.value.netSalesCents>0&&sa.available&&sb.available&&clean(sa.quality)&&clean(sb.quality)&&
   verifiedPeriodDays(a,recent)!==null&&verifiedPeriodDays(b,old)!==null;
  await gap("operating_margin_coverage",!valid);
  if(valid&&after.available&&before.available){
   const current=after.value.operatingMargin,previous=before.value.operatingMargin;
   if(finite(current)&&finite(previous))await persist(fact("operating_margin", "cafe",current,previous,"ratio",previous-current>=.05,from,to));
  }
 },async()=>{
  const range={dateFrom:from,dateTo:today};
  const [labor,shifts]=await Promise.all([readCanonicalView(db,businessId,"cv_labor_entries",range,999),readCanonicalView(db,businessId,"cv_shifts",range,999)]);
  if(labor.error||shifts.error||labor.truncated||shifts.truncated||labor.rows.length>=999||shifts.rows.length>=999)throw Error("attendance_coverage_unknown");
  const obj=(v:unknown)=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
  for(const record of shifts.rows){
   const shift=obj(record.data),date=String(record.business_date);
   if(record.source!=="app"||record.status!=="actual"||shift.shift_status!=="published"||typeof shift.id!=="string"||typeof shift.employee_id!=="string"||typeof shift.start_local!=="string"||!date.match(/^\d{4}-\d{2}-\d{2}$/))continue;
   const start=fromZonedTime(date+"T"+shift.start_local,timezone).getTime();
   if(!finite(start)||now.getTime()<start+15*60000)continue;
   const sameDayShifts=shifts.rows.filter(e=>e.business_date===date&&e.source==="app"&&obj(e.data).employee_id===shift.employee_id&&obj(e.data).shift_status==="published");
   if(sameDayShifts.length!==1)continue;
   const matching=labor.rows.some(e=>e.business_date===date&&obj(e.data).employee_id===shift.employee_id&&typeof obj(e.data).clock_in==="string");
   // Missing attendance is a request for evidence, NEVER proof of absence.
   if(date===today||matching)await persist(fact("missed_clock_evidence",shift.id,matching?1:0,1,"recorded_clock_in",!matching,date,date));
  }
  for(const entry of labor.rows){
   const row=obj(entry.data);
   if(typeof row.employee_id!=="string"||typeof row.clock_in!=="string"||typeof row.id!=="string")continue;
   const matches=shifts.rows.filter(s=>s.source==="app"&&s.status==="actual"&&s.business_date===entry.business_date&&obj(s.data).employee_id===row.employee_id&&obj(s.data).shift_status==="published");
   if(matches.length!==1)continue;
   const shift=obj(matches[0].data),date=String(matches[0].business_date);
   if(typeof shift.start_local!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(date))continue;
   const scheduled=fromZonedTime(date+"T"+shift.start_local,timezone).toISOString();
   const clock=Date.parse(row.clock_in),start=Date.parse(scheduled);
   if(!finite(clock)||!finite(start))continue;
   await persist(fact("early_clock_in",row.id,(start-clock)/60000,7,"minutes_early",isEarlyClockIn(row.clock_in,scheduled),date,date));
  }
 });
 work.push(async()=>{
  const [a,b,read,checked]=await Promise.all([historical.salesTrend(businessId,recent),historical.salesTrend(businessId,old),readCanonicalView(db,businessId,"cv_voids_refunds",{dateFrom:old.from,dateTo:to},999),db.rpc("supervisor_checked_order_refunds",{p_business_id:businessId,p_from:old.from,p_to:to})]);
  if(checked.error)throw checked.error;
  const covered=Array.isArray(checked.data)?checked.data as Array<{business_date:string;refund_cents:number}>:[];
  const verifiedTotal=(period:{from:string;to:string})=>{
   const rows=covered.filter(d=>d.business_date>=period.from&&d.business_date<=period.to);
   return rows.length===7&&new Set(rows.map(d=>d.business_date)).size===7&&rows.every(d=>Number.isSafeInteger(d.refund_cents)&&d.refund_cents>=0)?rows.reduce((n,d)=>n+d.refund_cents,0):null;
  };
  const comparable=a.available&&b.available&&clean(a.quality)&&clean(b.quality);
  const active=verifiedTotal(recent),baseline=verifiedTotal(old);
  await gap("refund_order_cohort_coverage",!comparable||active===null||baseline===null);
  if(comparable)await persist(compareCheckedRefunds(active,baseline,from,to));
  if(read.error||read.truncated||read.rows.length>=999)throw Error("refund_sources_incomplete");
  // This is a comparison of explicitly recorded refund events, not a claim
  // that every POS refund has been imported. Absence is not verified zero.
  const refunds=read.rows.filter(row=>row.status==="actual"&&String(row.source_ref).startsWith("refund:")&&finite(row.amount_cents));
  const sum=(period:{from:string;to:string})=>{
   const rows=refunds.filter(row=>String(row.business_date)>=period.from&&String(row.business_date)<=period.to);
   return rows.length?rows.reduce((total,row)=>total+Math.abs(Number(row.amount_cents)),0):null;
  };
  if(a.available&&b.available&&clean(a.quality)&&clean(b.quality))
   await persist(compareBusinessFacts("recorded_refund_rise","cafe",sum(recent),sum(old),"recorded_refund_cents",from,to,to,"up"));
 });
 work.push(async()=>{
  const live=await readSavedTodayLive(db,businessId,now);
  if(!live)return; // Not every café has a live POS feed. No invented outage.
  const v=live.value;
  if(v.businessDate!==today||live.ageMs>TODAY_LIVE_FRESH_MS||!Number.isFinite(live.ageMs)||v.locationsFailed||!v.locationsRead||v.truncated||v.unparsedOrders||Date.parse(v.readAt)>now.getTime()){
   await gap("live_sales_coverage",true);return;
  }
  const range={from:day(today,-28),to};
  const [closed,hourly]=await Promise.all([historical.salesTrend(businessId,range),posFactReaders(db,businessId).peakHours(range)]);
  if(!closed.available||!hourly.available||!clean(closed.quality)||!clean(hourly.quality)){
   await gap("live_sales_coverage",true);return;
  }
  const hour=Number(formatInTimeZone(new Date(v.readAt),timezone,"H"));
  const comparison=compareLiveEventSales(closed.value,indexHourlyRevenue(hourly.value.hours),today,v.netSalesCents,hour,new Set());
  const valid=comparison!==null&&comparison.typicalCents!==null&&comparison.changePercent!==null;
  await gap("live_sales_coverage",!valid);
  if(!valid||!comparison||comparison.typicalCents===null||comparison.changePercent===null)return;
  // Canonical comparator only flags a decline after accounting for the partial current hour.
  for(const [family,sign] of [["live_sales_decline",-1],["live_sales_growth",1]] as const)
   await persist(fact(family,"cafe",comparison.actualCents,comparison.typicalCents,"provisional_cents_through_hour_"+hour,comparison.notable&&comparison.changePercent*sign>0,today,today));
 });
 work.push(async()=>{
  const range={from:day(today,-28),to};
  const [sales,hours,cards]=await Promise.all([
   historical.salesTrend(businessId,range),
   posFactReaders(db,businessId).peakHours(range),
   readTimecardsForInterval(db,businessId,fromZonedTime(range.from+"T00:00:00",timezone).toISOString(),fromZonedTime(today+"T00:00:00",timezone).toISOString()),
  ]);
  if(!sales.available||!hours.available||!clean(sales.quality)||hours.quality.missingInputs.some(key=>key!=="hourlySalesDatesNotObserved")||hours.quality.estimatedInputs.length||hours.quality.staleInputs.length){await gap("hourly_staff_pressure_coverage",true);return;}
  const result=hourlyStaffPressure(sales.value,hours.value.hours,cards.filter(c=>c.source_type!=="owner_schedule").map(c=>({
   actual:c.wage_source!=="estimate"&&c.wage_source!=="unknown"&&c.wage_source!=null,clockIn:c.clock_in,clockOut:c.clock_out,
   hourlyWageCents:c.hourly_wage_cents,breaks:c.breaks??[],
   providerRegularHours:c.provider_regular_hours==null?null:Number(c.provider_regular_hours),
   providerOvertimeHours:c.provider_overtime_hours==null?null:Number(c.provider_overtime_hours),
  })),timezone,now);
  await gap("hourly_staff_pressure_coverage",!result.slots.length);
  for(const slot of result.slots)await persist(fact("overstaffed_hour",slot.subject,slot.highWeeks,slot.sampleWeeks,"allocated_staff_cost_ratio_above_45pct_weeks",slot.active,range.from,to));
 });
 work.push(async()=>{
  const periods=comparableRecoveryPeriods(today);
  if(!periods)return;
  const [a,b,sa,sb]=await Promise.all([getBusinessSnapshotFromDb(db,businessId,periods.current),getBusinessSnapshotFromDb(db,businessId,periods.previous),historical.salesTrend(businessId,periods.current),historical.salesTrend(businessId,periods.previous)]);
  const pa=cafeStateFromSnapshot(a,periods.current).profitability,pb=cafeStateFromSnapshot(b,periods.previous).profitability;
  const current=pa.available&&clean(pa.quality)&&sa.available&&clean(sa.quality)?verifiedRecoveryRatio(a,periods.current):null;
  const previous=pb.available&&clean(pb.quality)&&sb.available&&clean(sb.quality)?verifiedRecoveryRatio(b,periods.previous):null;
  await gap("cost_recovery_coverage",current===null||previous===null);
  if(current===null||previous===null)return;
  await persist(fact("cost_recovery_lag","cafe",current,previous,"ratio",previous-current>=.10,periods.current.from,periods.current.to));
  await persist(fact("cost_recovery_ahead","cafe",current,previous,"ratio",current-previous>=.10,periods.current.from,periods.current.to));
 });
 const names=["catalog_history","sales","wages","expenses","ingredient_product_cost","inventory_usage","supplier_quotes","operating_margin","attendance","refunds","live_sales","hourly_staff_pressure","cost_recovery"];
 const results=await Promise.allSettled(work.map(async(run,index)=>{
  try{await run();}catch(error){await gap("reader_unavailable:"+names[index],true);throw error;}
  await gap("reader_unavailable:"+names[index],false);
 }));
 if(results.some(r=>r.status==="rejected"))throw Error("business_anomaly_refresh_incomplete");
 return created;
}
