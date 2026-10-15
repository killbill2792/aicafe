import "server-only";
import { z } from "zod";
import { createAuthenticatedCafeTools, readSupervisorCafeIdentity } from "@/lib/ai/cafeTools.server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readP1BusinessProfile, readP1Recipe, readP1Ingredients, readP1EmployeeWages, readP1SupplierQuotes, readP1OwnerRules, readP1SchedulingFoundation, readP1ExpenseEntries, readP1RecurringBillRows, readP1TaskPage, readP1DecisionPage, readP1MenuCatalog } from "./p1Additional.server";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { discoverP1, discoverP1Inventory, additionalSurfaces, classified, inputFor, metricUnits, purposePolicies, readers, sourcePolicies, values,
  type SupportedId, quality, slice } from "./p1Catalog";

const limits = { maxOutputBytes: 100_000 } as const;
const validIds = new Set<string>(Object.keys(values));
const unavailable = (reason: string) => ({status:"unavailable" as const,value:null,reason});
const resultQuality = z.strictObject({
  level:z.enum(["low","medium","high"]),
  missingInputs:z.array(z.string().max(500)).max(200),
  estimatedInputs:z.array(z.string().max(500)).max(200),
  staleInputs:z.array(z.string().max(500)).max(200),
});
const provenance = z.strictObject({
  canonicalReaderId:z.string().min(1).max(120), readerContractVersion:z.literal(1),
  selectorContractId:z.string().min(1).max(160), selectorContractVersion:z.literal(1),
  purpose:z.string().min(1).max(120), asOf:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone:z.string().min(1).max(100), sourceRevision:z.null(),
});
export const outputFor = (id: SupportedId) => {
  const unit=id in metricUnits?metricUnits[id as keyof typeof metricUnits]:"typed_record";
  const valueKind=unit==="USD_cents"?"money_cents":unit==="ratio"?"decimal_ratio":"record";
  const base={
    id:z.literal(id),version:z.literal(1),
    query:inputFor(id),
    unit:z.literal(unit),valueKind:z.literal(valueKind),
    quality:resultQuality,provenance,
    freshness:z.strictObject({asOf:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      capturedAt:z.null(),stale:z.null()}),
  };
  return z.discriminatedUnion("status",[
    z.strictObject({
      ...base,status:z.literal("verified"),value:values[id],
      completeness:z.literal("complete"),actuality:z.literal("actual"),
    }),
    z.strictObject({
      ...base,status:z.literal("estimated"),value:values[id],
      completeness:z.enum(["complete","partial"]),actuality:z.enum(["estimated","planned"]),
    }),
    z.strictObject({
      ...base,status:z.literal("partial"),value:values[id],
      completeness:z.literal("partial"),
      actuality:z.enum(["actual","estimated","planned","unknown"]),
    }),
    z.strictObject({status:z.literal("unavailable"),value:z.null(),reason:z.enum([
      "unknown_capability","invalid_request","unsupported_period","unavailable_source",
      "invalid_result","unauthorized","not_activated","unsupported","reader_failure",
      "source_incomplete","output_limit",
    ])}),
  ]).superRefine((result,ctx)=>{
    // A source with no revision cannot prove immutable complete actual/zero.
    if(result.status==="verified" && result.provenance.sourceRevision===null)
      ctx.addIssue({code:"custom",message:"Verified result lacks revisioned source"});
    if(result.status==="estimated" && !result.quality.estimatedInputs.length)
      ctx.addIssue({code:"custom",message:"Estimate must identify assumed input"});
  });
};

/**
 * Compiled, allowlisted readers. No businessId, timezone or asOf from model args.
 * BusinessScopedCafeTools has already bound the authenticated, selected café.
 * Each key is one concrete typed canonical read; no generic expression executor.
 */
const handlers: Record<SupportedId,(tools:BusinessScopedCafeTools,input:{
  period?:{from:string;to:string};productId?:string;page?:number;
},ctx:{asOf:string;timezone:string;businessId?:string})=>Promise<unknown>> = {
  "money.owner_profit_cents":async(t,a)=>{const r=await t.getProfitability(a.period!);return r.available?{...r,value:values['money.profitability'].safeParse(r.value).success?r.value.ownerProfitCents:null}:r;},
  "sales.net_sales_cents":async(t,a)=>{const r=await t.getProfitability(a.period!);return r.available?{...r,value:values['money.profitability'].safeParse(r.value).success?r.value.netSalesCents:null}:r;},
  "money.total_costs_cents":async(t,a)=>{const r=await t.getProfitability(a.period!);return r.available?{...r,value:values['money.profitability'].safeParse(r.value).success?r.value.totalCostsCents:null}:r;},
  "money.operating_margin_ratio":async(t,a)=>{const r=await t.getProfitability(a.period!);return r.available?{...r,value:values['money.profitability'].safeParse(r.value).success?r.value.operatingMargin:null}:r;},
  "money.recurring_monthly_bills_cents":async(t)=>{const r=await t.getMonthlyBills();return r.available?{...r,value:values['money.monthly_bills'].safeParse(r.value).success?r.value.totalCents:null}:r;},
  "money.recorded_spending_cents":async(t,a)=>{const r=await t.getRecordedExpenses(a.period!);return r.available?{...r,value:values['money.recorded_spending'].safeParse(r.value).success?r.value.totalCents:null}:r;},
  "business.profile":(_t,_a,ctx)=>readP1BusinessProfile({businessId:ctx.businessId ?? ""}),
  "menu.recipe":(_t,a,ctx)=>readP1Recipe({businessId:ctx.businessId ?? ""},a.productId!),
  "menu.ingredients":(_t,_a,ctx)=>readP1Ingredients({businessId:ctx.businessId ?? ""}),
  "labor.employee_wages":(_t,_a,ctx)=>readP1EmployeeWages({businessId:ctx.businessId ?? ""}),
  "supplies.quotes":(_t,_a,ctx)=>readP1SupplierQuotes({businessId:ctx.businessId ?? ""}),
  "team.owner_rules":(_t,_a,ctx)=>readP1OwnerRules({businessId:ctx.businessId ?? ""}),
  "labor.availability_foundation":(_t,_a,ctx)=>readP1SchedulingFoundation({businessId:ctx.businessId ?? ""}),
  "money.expense_entries":(_t,a,ctx)=>readP1ExpenseEntries({businessId:ctx.businessId ?? ""},a.period!),
  "money.profitability":(t,a)=>t.getProfitability(a.period!),
  "money.business_costs":(t,a)=>t.getBusinessCostSummary(a.period!),
  "menu.product_economics":(t,a)=>t.getProductEconomics(a.productId!),
  "sales.daily":(t,a)=>t.getSalesTrend(a.period!),
  "pricing.recommendation":(t,a)=>t.getPricingRecommendation(a.productId!),
  "money.recurring_bill_rows":(_t,_a,ctx)=>readP1RecurringBillRows({businessId:ctx.businessId ?? ""}),
  "money.monthly_bills":t=>t.getMonthlyBills(),
  "money.recorded_spending":(t,a)=>t.getRecordedExpenses(a.period!),
  "sales.item_units":(t,a)=>t.getProductSales(a.period!),
  "sales.item_coverage":(t,a)=>t.getItemSalesCoverage(a.period!),
  "menu.catalog":(_t,_a,ctx)=>readP1MenuCatalog({businessId:ctx.businessId??""}),
  "labor.attendance":(t,a,ctx)=>t.getStaffAttendance(a.period!,ctx.timezone),
  "labor.current_staff":t=>t.getCurrentStaff(),
  "labor.recurring_assignments":(t,a,ctx)=>t.getRecurringSchedule(a.period!,ctx.asOf),
  "money.break_even":t=>t.getBreakEven(),
  "labor.daily_costs":(t,a)=>t.getLaborMetrics(a.period!),
  "team.decisions":(_t,a,ctx)=>readP1DecisionPage({businessId:ctx.businessId??""},a.page??0),
  "team.tasks":(_t,a,ctx)=>readP1TaskPage({businessId:ctx.businessId??""},a.page??0),
};
export const registeredHandlerIds = Object.freeze(Object.keys(handlers));

function isPeriodAllowed(id:SupportedId,p:{from:string;to:string}|undefined,asOf:string):boolean {
  if(!p)return true;
  // Money's canonical business-cost reader permits exactly the 7 calendar days
  // ending today across the previous-month boundary, never arbitrary history.
  if(id==="money.business_costs"){
    const weekStart=new Date(Date.parse(asOf+"T12:00:00Z")-6*86400000).toISOString().slice(0,10);
    return p.to<=asOf && (p.from>=asOf.slice(0,7)+"-01" ||
      (p.from===weekStart && p.to===asOf));
  }
  // State-derived profitability/scalars and labor retain their actual current
  // month snapshot bounds; daily sales/expense entry readers are separate.
  if(new Set(["money.profitability","money.owner_profit_cents",
    "sales.net_sales_cents","money.total_costs_cents","money.operating_margin_ratio",
    "labor.daily_costs"]).has(id))
    return p.from>=asOf.slice(0,7)+"-01" && p.to<=asOf;
  if(id==="labor.recurring_assignments")return p.from>=asOf;
  return p.to<=asOf;
}

/** Internal test seam accepts only a PRE-AUTHORIZED business-scoped facade.
 * No API/model can supply one; the production entrypoints authenticate first.
 */
export async function executeP1Authorized(
  tools:BusinessScopedCafeTools, identity:{asOf:string;timezone:string;businessId?:string},
  request:unknown,
):Promise<unknown> {
  if(!identity.asOf || !identity.timezone ||
     !/^\d{4}-\d{2}-\d{2}$/.test(identity.asOf)) return unavailable("unauthorized");
  if(!request || typeof request!=="object" || Array.isArray(request))return unavailable("invalid_request");
  const raw=request as Record<string,unknown>;
  if(typeof raw.id!=="string")return unavailable("unknown_capability");
  if(!validIds.has(raw.id)){
    if(Object.hasOwn(additionalSurfaces,raw.id))return unavailable("unsupported");
    if(Object.hasOwn(classified,raw.id))return unavailable("unsupported");
    return unavailable("unknown_capability");
  }
  const id=raw.id as SupportedId;
  const parsed=inputFor(id).safeParse(raw);
  if(!parsed.success)return unavailable("invalid_request");
  const args=parsed.data as {id:string;version:1;purpose:string;period?:{from:string;to:string};productId?:string;page?:number};
  // Critical: validate selected analysis purpose AND corresponding policy.
  const allowed=purposePolicies[id] as readonly string[];
  if(!allowed.includes(args.purpose)||!Object.hasOwn(sourcePolicies[id],args.purpose))
    return unavailable("invalid_request");
  const selected=sourcePolicies[id][args.purpose];
  if(selected.canonicalReaderId!==readers[id] || selected.sourcePurpose!==args.purpose ||
     selected.selectorContractVersion!==1 || selected.readerContractVersion!==1)
    return unavailable("invalid_result");
  if(!isPeriodAllowed(id,args.period,identity.asOf))return unavailable("unsupported_period");

  let rawResult:unknown;
  try { rawResult=await handlers[id](tools,args,identity); }
  catch {return unavailable("reader_failure");}
  // The canonical sources return a KnownSlice except for business cost summary.
  // Validate both the envelope and the nested value, never repair bad money.
  const validated=id==="money.business_costs"
    ? values[id].safeParse(rawResult)
    : slice(values[id]).safeParse(rawResult);
  if(!validated.success)return unavailable("invalid_result");
  const record=validated.data;
  if(id==="money.business_costs"){
    const summary=record as {completeness:string;period:{from:string;to:string};
      observed:Record<string,boolean>;missingInputs:string[]};
    if(summary.completeness==="unavailable")return unavailable("unavailable_source");
    if(!args.period || summary.period.from!==args.period.from ||
       summary.period.to!==args.period.to ||
       !Object.values(summary.observed).some(Boolean))return unavailable("invalid_result");
    if(summary.completeness==="complete"&&summary.missingInputs.length)
      return unavailable("invalid_result");
  }
  const known=id==="money.business_costs"
    ? {available:true as const,value:record,quality:{
        level:"high" as const,missingInputs:(record as {missingInputs:string[]}).missingInputs,
        estimatedInputs:(record as {estimatedInputs:string[]}).estimatedInputs,
        staleInputs:[] as string[],
      }}
    : record as {available:boolean;value:unknown;quality:z.infer<typeof quality>};
  if(!known.available)return unavailable("unavailable_source");
  const q=resultQuality.safeParse(known.quality);
  if(!q.success)return unavailable("invalid_result");
  const incomplete=q.data.missingInputs.length>0 || q.data.staleInputs.length>0 ||
    (id==="money.business_costs" && (record as {completeness:string}).completeness!=="complete");
  const estimated=q.data.estimatedInputs.length>0;
  // A null revision is *not* immutable source evidence. Preserve the truthful
  // observed subtotal but never upgrade it to a revision-proven verified figure.
  const output={
    status:incomplete?"partial":estimated?"estimated":"partial",
    id,version:1,query:args,unit:id in metricUnits?metricUnits[id as keyof typeof metricUnits]:"typed_record",
    valueKind:id in metricUnits ? (metricUnits[id as keyof typeof metricUnits]==="ratio"?"decimal_ratio":"money_cents") : "record",
    value:known.value,quality:q.data,
    provenance:{
      canonicalReaderId:readers[id],readerContractVersion:1,
      selectorContractId:selected.selectorContractId,selectorContractVersion:1,
      purpose:args.purpose,asOf:identity.asOf,timezone:identity.timezone,
      sourceRevision:null,
    },
    freshness:{asOf:identity.asOf,capturedAt:null,stale:null},
    completeness:"partial",
    actuality:new Set<string>(["labor.recurring_assignments","money.monthly_bills",
      "money.recurring_bill_rows","money.recurring_monthly_bills_cents"]).has(id)
      ? "planned" : estimated ? "estimated" : "actual",
  };
  if(JSON.stringify(output).length>limits.maxOutputBytes)return unavailable("output_limit");
  // Explicit schema gate on the ENTIRE output envelope, not just the number.
  const checked=outputFor(id).safeParse(output);
  return checked.success?checked.data:unavailable("invalid_result");
}

/** Only metadata that an authenticated owner is permitted to discover.
 * No unsanctioned external capabilities or private table names.
 */
export async function authorizedOwnerP1() {
  const user=await requireOwnBusiness();
  if(!user) throw new Error("Unauthorized");
  const businessId=await getActiveBusinessId(user.id);
  const supabase=await createServerSupabaseClient();
  const membership=await supabase.from("memberships")
    .select("role,businesses(is_demo)")
    .eq("user_id",user.id).eq("business_id",businessId).eq("role","owner")
    .maybeSingle();
  if(membership.error||!membership.data||membership.data.role!=="owner") throw new Error("Unauthorized");
  const raw=membership.data.businesses as unknown as {is_demo:boolean}|{is_demo:boolean}[]|null;
  const business=Array.isArray(raw)?raw[0]:raw;
  // Shared demo business ID is immutable even if a demo manager changes the
  // mutable is_demo column. Never use that flag as the only authorization root.
  if(businessId==="11111111-1111-1111-1111-111111111111" ||
     !business || business.is_demo!==false)throw new Error("Unauthorized");
  const tools=await createAuthenticatedCafeTools();
  const identity=await readSupervisorCafeIdentity(businessId);
  return {tools,identity:{...identity,businessId}};
}

/** No sensitive definitions are discoverable to a non-owner or a demo member. */
export async function discoverAuthenticatedP1() {
  await authorizedOwnerP1();
  return discoverP1();
}

/** Opt-in internal server API for future P2. Not mounted as an external API route
 * and never called by the existing production Supervisor router.
 */
export async function readAuthenticatedP1(request:unknown):Promise<unknown> {
  try {
    const {tools,identity}=await authorizedOwnerP1();
    return executeP1Authorized(tools,{asOf:identity.asOf,timezone:identity.timezone,businessId:identity.businessId},request);
  }catch{return unavailable("unauthorized");}
}

/** Authorized full inventory includes explicitly unsupported and restricted entries. */
export async function discoverAuthenticatedP1Inventory() {
  await authorizedOwnerP1();
  return discoverP1Inventory();
}
