import "server-only";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { readPersistedOperatingTasks } from "@/lib/data/operatingTasks";
import { SnapshotCafeStateService } from "@/lib/operating/cafeState";
import { signalsFromPricing } from "@/lib/operating/signals";
import { SupabaseDecisionStore } from "@/lib/operating/supabaseDecisionStore";
import { BusinessScopedCafeTools, StructuredCafeTools } from "./tools";
import { totalMonthlyRecurringCostsCents } from "@/lib/expenses/recurringMonthlyTotal";
import type { CafeStatePeriod, KnownSlice } from "@/lib/operating/types";
import type { SupervisorBills, SupervisorRecordedExpenses } from "./tools";

/**
 * The future Supervisor backend must call this authenticated server factory.
 * It binds the owner-selected café once, and every downstream query uses existing
 * RLS-scoped readers. No LLM is given a business selector or a database client.
 *
 * Read only: never refreshes/syncs operating tasks or writes business records.
 * "Signals" are raw deterministic observations, NOT the actionable persisted
 * Needs You / Handled / Watching inbox (which retains its existing lifecycle).
 */
export async function createAuthenticatedCafeTools(): Promise<BusinessScopedCafeTools> {
  if (!isSupabaseConfigured()) {
    // A fixture is useful to test screens, but should never masquerade as a real
    // authenticated café inside the Supervisor's business tools.
    throw new Error("Authenticated café data is unavailable");
  }
  const user = await requireOwnBusiness();
  if (!user) throw new Error("Authenticated owner required");
  const businessId = await getActiveBusinessId(user.id);
  const client = await createServerSupabaseClient();

  const assertBusiness = (requested: string) => {
    if (requested !== businessId) throw new Error("Café access scope mismatch");
  };
  const pricingMenu = async (requested: string) => {
    assertBusiness(requested);
    // Uses the exact data source and pricing engine already used by Menu and Team.
    return getMenuControlCenter();
  };
  const states = new SnapshotCafeStateService(
    async (requested) => {
      assertBusiness(requested);
      const snapshot = await getSnapshot();
      if (snapshot.business.id !== businessId) throw new Error("Café snapshot business mismatch");
      return snapshot;
    },
    async (requested) => (await pricingMenu(requested)).map(({ id, pricing }) => ({ id, pricing })),
  );
  const tools = new StructuredCafeTools(
    states,
    new SupabaseDecisionStore(client),
    async (requested) => (await pricingMenu(requested))
      .flatMap((item) => item.pricing ? signalsFromPricing(item.id, item.pricing) : []),
    async (requested) => {
      assertBusiness(requested);
      return readPersistedOperatingTasks(requested);
    },
    async (requested): Promise<KnownSlice<SupervisorBills>> => {
      assertBusiness(requested);
      // Exactly the active entries and frequency normalization from the Bills page.
      const { data, error } = await client.from("recurring_costs")
        .select("amount_cents,frequency,is_estimate")
        .eq("business_id", requested).is("active_to", null);
      if (error) throw error;
      const rows = data ?? [];
      const amounts = rows.map(row => ({
        amountCents: row.amount_cents,
        frequency: row.frequency as "monthly" | "weekly" | "quarterly" | "yearly",
      }));
      if (amounts.some(row => !Number.isSafeInteger(row.amountCents) ||
          !["monthly", "weekly", "quarterly", "yearly"].includes(row.frequency))) {
        throw new Error("Invalid recurring bill data");
      }
      return {
        available: true, value: {
          amountCents: totalMonthlyRecurringCostsCents(amounts), rows: rows.length,
        },
        quality: { level: rows.some(row => row.is_estimate) ? "medium" : "high",
          missingInputs: [], staleInputs: [],
          estimatedInputs: rows.some(row => row.is_estimate) ? ["recurringBills"] : [] },
      };
    },
    async (requested, period: CafeStatePeriod): Promise<KnownSlice<SupervisorRecordedExpenses>> => {
      assertBusiness(requested);
      const { data, error } = await client.from("expenses")
        .select("amount_cents,status").eq("business_id", requested)
        .gte("spent_on", period.from).lte("spent_on", period.to);
      if (error) throw error;
      const rows = data ?? [];
      if (rows.some(row => !Number.isSafeInteger(row.amount_cents))) {
        throw new Error("Invalid recorded expense data");
      }
      // Actual expense records are kept separate from projected monthly bills.
      const actual = rows.filter(row => row.status === "actual");
      return { available: true,
        value: { amountCents: actual.reduce((sum, row) => sum + row.amount_cents, 0),
          rows: actual.length },
        quality: { level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [] } };
    },
  );
  return new BusinessScopedCafeTools(tools, businessId);
}
