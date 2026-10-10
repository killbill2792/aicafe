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
  );
  return new BusinessScopedCafeTools(tools, businessId);
}
