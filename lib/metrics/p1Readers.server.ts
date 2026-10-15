import "server-only";
import { z } from "zod";
import { createAuthenticatedCafeTools, readSupervisorCafeIdentity } from "@/lib/ai/cafeTools.server";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { discoverP1, inputFor, purposePolicies, readers, sourcePolicies, values,
  type SupportedId, quality, slice } from "./p1Catalog";

const limits = { maxRows: 1000, maxOutputBytes: 100_000 } as const;
const validIds = new Set<string>(Object.keys(values));
const unavailable = (reason: string) => ({status:"unavailable" as const,value:null,reason});
const safeReasons = new Set(["unknown_capability","invalid_request","unsupported_period",
  "unavailable_source","invalid_result","unauthorized","not_activated","unsupported",
  "reader_failure","source_incomplete","output_limit"]);
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
const outputFor = (id: SupportedId) => z.discriminatedUnion("status", [
  z.strictObject({
    status:z.literal("verified"),id:z.literal(id),version:z.literal(1),
    value:values[id],quality:resultQuality,provenance,completeness:z.literal("complete"),
    actuality:z.literal("actual"),
  }),
  z.strictObject({
    status:z.literal("estimated"),id:z.literal(id),version:z.literal(1),
    value:values[id],quality:resultQuality,provenance,
    completeness:z.enum(["complete","partial"]),actuality:z.literal("estimated"),
  }),
  z.strictObject({
    status:z.literal("partial"),id:z.literal(id),version:z.literal(1),
    value:values[id],quality:resultQuality,provenance,
    completeness:z.literal("partial"),actuality:z.enum(["actual","estimated","planned","unknown"]),
  }),
  z.strictObject({status:z.literal("unavailable"),value:z.null(),reason:z.enum([
    "unknown_capability","invalid_request","unsupported_period","unavailable_source",
    "invalid_result","unauthorized","not_activated","unsupported","reader_failure",
    "source_incomplete","output_limit",
  ])}),
]);

/**
 * Compiled, allowlisted readers. No businessId, timezone or asOf from model args.
 * BusinessScopedCafeTools has already bound the authenticated, selected café.
 * Each key is one concrete typed canonical read; no generic expression executor.
 */
const handlers: Record<SupportedId,(tools:BusinessScopedCafeTools,input:{
  period?:{from:string;to:string};productId?:string;
},ctx:{asOf:string;timezone:string})=>Promise<unknown>> = {
  "money.profitability":(t,a)=>t.getProfitability(a.period!),
  "money.business_costs":(t,a)=>t.getBusinessCostSummary(a.period!),
  "menu.product_economics":(t,a)=>t.getProductEconomics(a.productId!),
  "sales.daily":(t,a)=>t.getSalesTrend(a.period!),
  "pricing.recommendation":(t,a)=>t.getPricingRecommendation(a.productId!),
  "money.expense_categories":(t,a)=>t.getExpenseSummary(a.period!),
  "money.monthly_bills":t=>t.getMonthlyBills(),
  "money.recorded_spending":(t,a)=>t.getRecordedExpenses(a.period!),
  "sales.item_units":(t,a)=>t.getProductSales(a.period!),
  "sales.item_coverage":(t,a)=>t.getItemSalesCoverage(a.period!),
  "menu.catalog":t=>t.getMenuCatalog(),
  "labor.attendance":(t,a,ctx)=>t.getStaffAttendance(a.period!,ctx.timezone),
  "labor.current_staff":t=>t.getCurrentStaff(),
  "labor.recurring_assignments":(t,a,ctx)=>t.getRecurringSchedule(a.period!,ctx.asOf),
  "money.break_even":t=>t.getBreakEven(),
  "labor.daily_costs":(t,a)=>t.getLaborMetrics(a.period!),
  "team.tasks":t=>t.getTeamTasks(),
};
export const registeredHandlerIds = Object.freeze(Object.keys(handlers));

function isPeriodAllowed(id:SupportedId, p:{from:string;to:string}|undefined,asOf:string):boolean {
  if (!p) return true;
  // The current profit/cost reader only has this month's snapshot, and the
  // source for historical sales is daily, never an inferred hourly series.
  if (new Set(["money.profitability","money.business_costs","money.expense_categories",
    "labor.daily_costs"]).has(id)) return p.from.slice(0,7)===asOf.slice(0,7) &&
      p.from >= asOf.slice(0,7)+"-01" && p.to<=asOf;
  if (id==="labor.recurring_assignments")return p.from>=asOf;
  return p.to<=asOf;
}

/** Internal test seam accepts only a PRE-AUTHORIZED business-scoped facade.
 * No API/model can supply one; the production entrypoints authenticate first.
 */
export async function executeP1Authorized(
  tools:BusinessScopedCafeTools, identity:{asOf:string;timezone:string},
  request:unknown,
):Promise<unknown> {
  if(!identity.asOf || !identity.timezone ||
     !/^\d{4}-\d{2}-\d{2}$/.test(identity.asOf)) return unavailable("unauthorized");
  if(!request || typeof request!=="object" || Array.isArray(request))return unavailable("invalid_request");
  const raw=request as Record<string,unknown>;
  if(typeof raw.id!=="string"||!validIds.has(raw.id))return unavailable("unknown_capability");
  const id=raw.id as SupportedId;
  const parsed=inputFor(id).safeParse(raw);
  if(!parsed.success)return unavailable("invalid_request");
  const args=parsed.data as {id:string;version:1;purpose:string;period?:{from:string;to:string};productId?:string};
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
    id,version:1,value:known.value,quality:q.data,
    provenance:{
      canonicalReaderId:readers[id],readerContractVersion:1,
      selectorContractId:selected.selectorContractId,selectorContractVersion:1,
      purpose:args.purpose,asOf:identity.asOf,timezone:identity.timezone,
      sourceRevision:null,
    },
    completeness:incomplete?"partial":"partial",
    actuality:id==="labor.recurring_assignments"?"planned":estimated?"estimated":"actual",
  };
  if(JSON.stringify(output).length>limits.maxOutputBytes)return unavailable("output_limit");
  // Explicit schema gate on the ENTIRE output envelope, not just the number.
  const checked=outputFor(id).safeParse(output);
  return checked.success?checked.data:unavailable("invalid_result");
}

/** Only metadata that an authenticated owner is permitted to discover.
 * No unsanctioned external capabilities or private table names.
 */
export async function discoverAuthenticatedP1() {
  await createAuthenticatedCafeTools();
  return discoverP1();
}

/** Opt-in internal server API for future P2. Not mounted as an external API route
 * and never called by the existing production Supervisor router.
 */
export async function readAuthenticatedP1(request:unknown):Promise<unknown> {
  let tools:BusinessScopedCafeTools;
  try { tools=await createAuthenticatedCafeTools(); }
  catch { return unavailable("unauthorized"); }
  // Existing service authenticates owner selection; identity is looked up by the
  // trusted session-selected active business in the same authenticated request.
  // readSupervisorCafeIdentity requires a concrete bound ID, so use the
  // existing scoped summary for timezone/as-of without caller-supplied tenancy.
  try {
    const state=await tools.getCafeSummary();
    if(!state.business?.id || !state.business.timezone || !state.asOf)
      return unavailable("unavailable_source");
    const identity=await readSupervisorCafeIdentity(state.business.id);
    return executeP1Authorized(tools,{asOf:identity.asOf,timezone:identity.timezone},request);
  }catch{return unavailable("unavailable_source");}
}
