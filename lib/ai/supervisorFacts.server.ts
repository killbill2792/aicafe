import "server-only";
import {readCoveredSalesDates} from "@/lib/data/dailyFacts.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CafeStatePeriod, KnownSlice } from "@/lib/operating/types";
import { totalMonthlyRecurringCostsCents } from "@/lib/expenses/recurringMonthlyTotal";
import {resolveSalesCoverage} from "@/lib/calc/salesCoverage";

/** Distinct, verified facts. Neither scheduled bills nor elapsed running costs are cash spent. */
export type MonthlyBills = { totalCents: number };
export type RecordedExpenses = { totalCents: number };
export type ItemSalesCoverage = ReturnType<typeof resolveSalesCoverage>;
export type SoldProduct = { id: string; name: string; category: "drink" | "food"; units: number };

const safeCents=(value:unknown)=>{
 const n=typeof value==="number"?value:typeof value==="string"&&/^-?\d+$/.test(value)?Number(value):NaN;
 return Number.isSafeInteger(n)?n:null;
};
/** One stable, tenant-scoped PostgREST page at a time. Row caps are transport
 * limits, not business limits: continue until the exact full set is proved.
 * Requiring unique immutable IDs and a stable exact count fails closed on
 * concurrent page drift, rather than silently publishing a partial subtotal. */
async function readCompletePaged<T>(
 read:(start:number,end:number)=>PromiseLike<{data:T[]|null;error:unknown;count?:number|null}>,
 identity:(row:T)=>unknown
):Promise<T[]|null>{
 const rows:T[]=[];const seen=new Set<string>();let expected:number|null=null;
 for(let start=0;;start+=1000){
  if(!Number.isSafeInteger(start+999))return null;
  const page=await read(start,start+999);
  if(page.error)throw page.error;
  if(!Array.isArray(page.data)||page.data.length>1000)return null;
  if(page.count!=null){
   if(!Number.isSafeInteger(page.count)||page.count<0||
      (expected!==null&&expected!==page.count))return null;
   expected=page.count;
  }
  for(const row of page.data){
   const key=identity(row);
   if(typeof key!=="string"||!key||seen.has(key))return null;
   seen.add(key);rows.push(row);
  }
  if(expected!==null&&rows.length>expected)return null;
  if(expected!==null&&rows.length===expected)break;
  if(page.data.length<1000)break;
 }
 return expected===null||rows.length===expected?rows:null;
}
function known<T>(value: T, estimated = false): KnownSlice<T> {
  return { available: true, value, quality: {
    level: estimated ? "medium" : "high",
    missingInputs: [], estimatedInputs: estimated ? ["recurringBills"] : [], staleInputs: [],
  } };
}
function missing<T>(reason: string): KnownSlice<T> {
  return { available: false, value: null, quality: {
    level: "low", missingInputs: [reason], estimatedInputs: [], staleInputs: [],
  } };
}

export function resolveItemSalesCoverage(
 connections:Array<{provider:string;last_synced_at:string|null;backfill_completed_at:string|null}>,
 period:CafeStatePeriod,actualDays:readonly string[]=[]
):ItemSalesCoverage{
 return resolveSalesCoverage(period,actualDays,connections);
}

/** The same active rows and monthly-equivalent helper used by getRecurringCosts/BillsManager. */
export function supervisorFactReaders(client: SupabaseClient, authorizedBusinessId: string) {
  function assertScope(businessId: string) {
    if (!businessId || businessId !== authorizedBusinessId) throw new Error("Café access scope mismatch");
  }

  return {
    async itemSalesCoverage(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<ItemSalesCoverage>> {
      assertScope(businessId);
      const { data, error } = await client.from("pos_connections")
        .select("provider,last_synced_at,backfill_completed_at").eq("business_id",businessId).eq("status","active");
      if (error) throw error;
      const covered=await readCoveredSalesDates(client,businessId,period.from,period.to);
      const coverage=resolveItemSalesCoverage(data??[],period,covered);
      return coverage.coveredDays?{
        ...known(coverage),quality:{level:coverage.covered?"high":"medium",
          missingInputs:coverage.missingDays.map(day=>"salesDay:"+day),
          estimatedInputs:[],staleInputs:[]}
      }:missing("itemSalesCoverageNotProven");
    },
    async monthlyBills(businessId: string): Promise<KnownSlice<MonthlyBills>> {
      assertScope(businessId);
      const data=await readCompletePaged((start,end)=>client.from("recurring_costs")
        .select("id,amount_cents,frequency,is_estimate",{count:"exact"})
        .eq("business_id",businessId).is("active_to",null)
        .order("id",{ascending:true}).range(start,end),row=>row.id);
      if(!data)return missing("recurringBillsCoverageUnverified");
      if (!data?.length) return missing("recurringBillsNotConfigured");
      if(data.some(row=>safeCents(row.amount_cents)===null||
        !["monthly","weekly","quarterly","yearly"].includes(row.frequency)))
        return missing("recurringBillsAmountsUnverified");
      const costs = data.map((row) => ({
        amountCents: safeCents(row.amount_cents)!,
        frequency: row.frequency as "monthly" | "weekly" | "quarterly" | "yearly",
      }));
      const total=totalMonthlyRecurringCostsCents(costs);
      if(!Number.isSafeInteger(total))return missing("recurringBillsAmountsUnverified");
      return known({ totalCents: total },
        data.some((row) => row.is_estimate));
    },

    async recordedExpenses(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<RecordedExpenses>> {
      assertScope(businessId);
      const data=await readCompletePaged((start,end)=>client.from("expenses")
        .select("id,amount_cents,status",{count:"exact"}).eq("business_id",businessId)
        .gte("spent_on",period.from).lte("spent_on",period.to)
        .order("id",{ascending:true}).range(start,end),row=>row.id);
      if(!data)return missing("recordedExpensesCoverageUnverified");
      const actual = (data ?? []).filter((row) => row.status === "actual");
      if (!actual.length) return missing("noRecordedActualExpenseEntries");
      if(actual.some(row=>safeCents(row.amount_cents)===null))
        return missing("recordedExpensesAmountsUnverified");
      const total=actual.reduce((sum,row)=>sum+safeCents(row.amount_cents)!,0);
      return Number.isSafeInteger(total)?known({totalCents:total}):
        missing("recordedExpensesAmountsUnverified");
    },

    /** Order-lines RPC is invoker-security, scoped by business AND its underlying RLS.
     * Only an explicitly supported provider policy can prove canonical item coverage.
     * Without both, even a nonzero sum is only an observed subset, not a total.
     */
    async productSales(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<SoldProduct[]>> {
      assertScope(businessId);
      const { data: connections, error: connectionError } = await client.from("pos_connections")
        .select("provider, last_synced_at, backfill_completed_at")
        .eq("business_id", businessId).eq("status", "active");
      if (connectionError) throw connectionError;
      const covered=await readCoveredSalesDates(client,businessId,period.from,period.to);
      const coverage=resolveItemSalesCoverage(connections??[],period,covered);
      if(!coverage.covered)return missing("itemSalesCoverage");
      const [items, quantityRows] = await Promise.all([
        readCompletePaged((start,end)=>client.from("menu_items")
          .select("id,name,category",{count:"exact"}).eq("business_id",businessId)
          .order("id",{ascending:true}).range(start,end),row=>row.id),
        readCompletePaged((start,end)=>client.rpc("menu_item_quantities_sold",{
          p_business_id:businessId,p_from:period.from,p_to:period.to
        },{count:"exact"}).order("menu_item_id",{ascending:true}).range(start,end),
          row=>row.menu_item_id),
      ]);
      if(!items||!quantityRows)return missing("productSalesRowsIncomplete");
      const knownIds=new Set(items.map(item=>item.id));
      const seenIds=new Set<string>();
      for(const row of quantityRows){
       const units=Number(row.total_quantity);
       if(typeof row.menu_item_id!=="string"||!knownIds.has(row.menu_item_id)||
          seenIds.has(row.menu_item_id)||!Number.isSafeInteger(units)||units<0)
        return missing("productSalesMappingUnverified");
       seenIds.add(row.menu_item_id);
      }
      const byId = new Map<string, number>(quantityRows.map((row) =>
        [row.menu_item_id, Number(row.total_quantity)]));
      // Preserve archived products, as historic sales can include inactive menu items.
      const sold=items.map((item) => ({
        id: item.id, name: item.name,
        category: item.category === "food" ? "food" as const : "drink" as const,
        units: byId.get(item.id) ?? 0,
      }));
      return {available:true,value:sold,quality:{
        level:coverage.covered?"high":"medium",estimatedInputs:[],staleInputs:[],
        missingInputs:coverage.missingDays.map(day=>"salesDay:"+day)}};
    },
  };
}
