import { posFactReaders } from "@/lib/data/posFactReaders.server";
import "server-only";
import {readSchedulingDraftInputs} from "@/lib/data/schedulingDraftInputs.server";
import { agentSourceReaders } from "@/lib/data/agentReadSources.server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { getStaffSchedules } from "@/lib/data/getStaffSchedules";
import { projectCurrentStaff, projectBreakEven, projectRecurringSchedule } from "./conversations/domainProjections";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { readPersistedOperatingTasks } from "@/lib/data/operatingTasks";
import { SnapshotCafeStateService } from "@/lib/operating/cafeState";
import { signalsFromPricing } from "@/lib/operating/signals";
import { SupabaseDecisionStore } from "@/lib/operating/supabaseDecisionStore";
import { BusinessScopedCafeTools, StructuredCafeTools } from "./tools";
import { supervisorFactReaders } from "./supervisorFacts.server";
import { supervisorHistoricalReaders } from "./supervisorReads.server";
import { readPeriodItemSales } from "@/lib/data/periodItemSales.server";

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
  let snapshotPromise: ReturnType<typeof getSnapshot> | null = null;
  const currentSnapshot = () => snapshotPromise ??= getSnapshot();
  const states = new SnapshotCafeStateService(
    async (requested,period) => {
      assertBusiness(requested);
      const snapshot = await currentSnapshot();
      if (snapshot.business.id !== businessId) throw new Error("Café snapshot business mismatch");
      if(!period||snapshot.periodItemSales?.period.from===period.from&&
        snapshot.periodItemSales.period.to===period.to)return snapshot;
      // Target the exact authorized date range; never reuse a month/28-day
      // quantity as proof for today or another custom window.
      const periodItemSales=await readPeriodItemSales(client,businessId,period);
      return {...snapshot,periodItemSales};
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
    supervisorFactReaders(client, businessId),
    supervisorHistoricalReaders(client, businessId),
    agentSourceReaders(client,businessId),
    posFactReaders(client,businessId),
    {
      schedulingDraftInputs:async(requested)=>{assertBusiness(requested);return readSchedulingDraftInputs(client,businessId);},
      currentStaff: async (requested) => {
        assertBusiness(requested);
        const snapshot = await currentSnapshot();
        if(snapshot.business.id !== businessId) throw new Error("Café snapshot scope mismatch");
        return {available:true,value:projectCurrentStaff(snapshot),quality:{
          level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}};
      },
      recurringSchedule: async (requested,range,asOf) => {
        assertBusiness(requested);
        const [rows, employees] = await Promise.all([
          getStaffSchedules(),client.from("employees").select("id,display_name").eq("business_id",businessId).limit(200),
        ]);
        if(employees.error) throw employees.error;
        const byId = Object.fromEntries((employees.data ?? []).map(e=>[e.id,e.display_name]));
        return projectRecurringSchedule(rows,byId,range,asOf);
      },
      breakEven: async (requested) => {
        assertBusiness(requested);
        const snapshot = await currentSnapshot();
        if(snapshot.business.id !== businessId) throw new Error("Café snapshot scope mismatch");
        return projectBreakEven(snapshot);
      },
    },
  );
  return new BusinessScopedCafeTools(tools, businessId);
}

/** Owner-scoped calendar and café identity without loading the mutable Home snapshot. */
export async function readSupervisorCafeIdentity(authorizedBusinessId: string) {
  const client = await createServerSupabaseClient();
  const { data, error } = await client.from("businesses").select("id,name,timezone")
    .eq("id",authorizedBusinessId).single();
  if (error || !data || data.id !== authorizedBusinessId) throw new Error("Café identity unavailable");
  // en-CA has historically varied by Node ICU; formatToParts yields an invariant ISO date.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone:data.timezone,year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(new Date());
  const value = (kind: string) => parts.find(p=>p.type===kind)?.value ?? "";
  return { cafeName:String(data.name).slice(0,120), timezone:String(data.timezone),
    asOf:value("year")+"-"+value("month")+"-"+value("day") };
}
