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
      const { data, error } = await client.from("recurring_costs")
        .select("amount_cents, frequency, is_estimate")
        .eq("business_id", businessId).is("active_to", null);
      if (error) throw error;
      if (!data?.length) return missing("recurringBillsNotConfigured");
      const costs = data.map((row) => ({
        amountCents: Number(row.amount_cents),
        frequency: row.frequency as "monthly" | "weekly" | "quarterly" | "yearly",
      }));
      return known({ totalCents: totalMonthlyRecurringCostsCents(costs) },
        data.some((row) => row.is_estimate));
    },

    async recordedExpenses(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<RecordedExpenses>> {
      assertScope(businessId);
      const { data, error } = await client.from("expenses")
        .select("amount_cents, status").eq("business_id", businessId)
        .gte("spent_on", period.from).lte("spent_on", period.to);
      if (error) throw error;
      const actual = (data ?? []).filter((row) => row.status === "actual");
      if (!actual.length) return missing("noRecordedActualExpenseEntries");
      return known({ totalCents: actual.reduce((sum, row) => sum + Number(row.amount_cents), 0) });
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
      if(!coverage.coveredDays)return missing("itemSalesCoverage");
      const [items, quantities] = await Promise.all([
        client.from("menu_items").select("id, name, category").eq("business_id", businessId),
        client.rpc("menu_item_quantities_sold", {
          p_business_id: businessId, p_from: period.from, p_to: period.to,
        }),
      ]);
      if (items.error) throw items.error;
      if (quantities.error) throw quantities.error;
      const quantityRows = (quantities.data ?? []) as Array<{ menu_item_id: string; total_quantity: number | string }>;
      const byId = new Map<string, number>(quantityRows.map((row) =>
        [row.menu_item_id, Number(row.total_quantity)]));
      // Preserve archived products, as historic sales can include inactive menu items.
      const sold=(items.data ?? []).map((item) => ({
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
