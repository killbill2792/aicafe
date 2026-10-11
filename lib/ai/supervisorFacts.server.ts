import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CafeStatePeriod, KnownSlice } from "@/lib/operating/types";
import { totalMonthlyRecurringCostsCents } from "@/lib/expenses/recurringMonthlyTotal";

/** Distinct, verified facts. Neither scheduled bills nor elapsed running costs are cash spent. */
export type MonthlyBills = { totalCents: number };
export type RecordedExpenses = { totalCents: number };
export type ItemSalesCoverage = {
  covered: boolean; sources: string[]; from: string | null; through: string | null;
};
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
  connections: Array<{provider:string;last_synced_at:string|null;backfill_completed_at:string|null}>,
  period: CafeStatePeriod,
): ItemSalesCoverage {
  const covered = connections.filter(connection=>{
    // Explicit contractual coverage only. Unknown connectors have no inferred 90-day backfill rule.
    if(connection.provider!=="square") return false;
    const startDate = connection.backfill_completed_at?.slice(0,10);
    const lastSynced = connection.last_synced_at?.slice(0,10);
    if (!startDate || !lastSynced) return false;
    const earliest = new Date(Date.parse(startDate+"T12:00:00Z")-89*86_400_000)
      .toISOString().slice(0,10);
    return earliest<=period.from && lastSynced>=period.to;
  });
  return {covered:covered.length>0,sources:[...new Set(covered.map(c=>c.provider))].slice(0,5),
    from:covered.length ? period.from : null,through:covered.length ? period.to : null};
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
      const coverage = resolveItemSalesCoverage(data ?? [],period);
      return coverage.covered ? known(coverage) : missing("itemSalesCoverageNotProven");
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
        .eq("business_id", businessId).eq("status", "active")
        .not("last_synced_at", "is", null).not("backfill_completed_at", "is", null);
      if (connectionError) throw connectionError;
      const coverage = resolveItemSalesCoverage(connections ?? [],period);
      const covered = coverage.covered;
      if (!covered) return missing("itemSalesCoverage");
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
      return known((items.data ?? []).map((item) => ({
        id: item.id, name: item.name,
        category: item.category === "food" ? "food" as const : "drink" as const,
        units: byId.get(item.id) ?? 0,
      })));
    },
  };
}
