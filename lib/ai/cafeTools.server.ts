import { posFactReaders } from "@/lib/data/posFactReaders.server";
import "server-only";
import {readUsageVariance} from "@/lib/data/usageVariance.server";
import {readSchedulingDraftInputs} from "@/lib/data/schedulingDraftInputs.server";
import { agentSourceReaders } from "@/lib/data/agentReadSources.server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { getSnapshot } from "@/lib/data/getSnapshot";
import {readHistoricalBusinessSnapshot} from "@/lib/data/snapshot.server";
import { getStaffSchedules } from "@/lib/data/getStaffSchedules";
import { projectCurrentStaff, projectBreakEven, projectRecurringSchedule } from "./conversations/domainProjections";
import type { StaffRosterMember } from "@/lib/viewmodels/staffViewModel";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { readPersistedOperatingTasks } from "@/lib/data/operatingTasks";
import { SnapshotCafeStateService } from "@/lib/operating/cafeState";
import { signalsFromPricing } from "@/lib/operating/signals";
import { SupabaseDecisionStore } from "@/lib/operating/supabaseDecisionStore";
import { BusinessScopedCafeTools, StructuredCafeTools } from "./tools";
import { supervisorFactReaders } from "./supervisorFacts.server";
import { supervisorHistoricalReaders } from "./supervisorReads.server";

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
  // Read the active roster once per authenticated café turn. Never infer active
  // membership from timecards, recurring patterns or historic POS display names.
  let activeTeamPromise: Promise<StaffRosterMember[]> | null = null;
  const activeTeam = () => activeTeamPromise ??= (async () => {
    const { data, error } = await client.from("employees")
      .select("id,display_name,role,active")
      .eq("business_id", businessId).eq("active", true).limit(501);
    if (error) throw error;
    if ((data ?? []).length > 500) throw new Error("activeTeamTruncated");
    return (data ?? []).map(row => ({
      id: row.id, name: row.display_name, role: row.role, active: true,
    }));
  })();
  let snapshotPromise: ReturnType<typeof getSnapshot> | null = null;
  const currentSnapshot = () => snapshotPromise ??= getSnapshot();
  const states = new SnapshotCafeStateService(
    async (requested,period) => {
      assertBusiness(requested);
      if(period){
        // Historical lookups must never materialize shifts or regenerate alerts.
        const historical=await readHistoricalBusinessSnapshot(client,businessId,period);
        if(historical.business.id!==businessId)throw new Error("Café snapshot scope mismatch");
        return historical;
      }
      const snapshot=await currentSnapshot();
      if(snapshot.business.id!==businessId)throw new Error("Café snapshot business mismatch");
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
        return {available:true,value:projectCurrentStaff(snapshot, await activeTeam()),quality:{
          level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}};
      },
      recurringSchedule: async (requested,range,asOf) => {
        assertBusiness(requested);
        const [rows, team] = await Promise.all([getStaffSchedules(), activeTeam()]);
        const activeById = Object.fromEntries(team.map(e=>[e.id,e.name]));
        return projectRecurringSchedule(rows.filter(row=>Object.hasOwn(activeById,row.employeeId)),
          activeById,range,asOf);
      },
      breakEven: async (requested) => {
        assertBusiness(requested);
        const snapshot = await currentSnapshot();
        if(snapshot.business.id !== businessId) throw new Error("Café snapshot scope mismatch");
        return projectBreakEven(snapshot);
      },
    },
    async (requested,input)=>{assertBusiness(requested);return readUsageVariance(input);},
    async(requested)=>{
      assertBusiness(requested);
      const {data,error}=await client.from("businesses")
        .select("owner_monthly_payroll_extras_cents").eq("id",requested).single();
      if(error)throw error;
      if(!data)throw new Error("Owner payroll setting unavailable");
      const amount=data.owner_monthly_payroll_extras_cents===null?null:
        Number(data.owner_monthly_payroll_extras_cents);
      if(amount!==null&&(!Number.isSafeInteger(amount)||amount<0))
        throw new Error("Invalid owner payroll setting");
      return {available:true,value:{monthlyCents:amount,
        source:amount===null?null:"owner_entered" as const},
        quality:{level:amount===null?"low" as const:"medium" as const,
          missingInputs:amount===null?["ownerMonthlyPayrollExtrasNotSet"]:[],
          estimatedInputs:amount===null?[]:["ownerMonthlyPayrollExtras"],
          staleInputs:[]}};
    },
    async(requested)=>{
      assertBusiness(requested);
      const {data,error}=await client.rpc("toast_business_scope_summary",{
        p_business_id:requested
      });
      if(error)throw error;
      const parsed=data as {menus?:unknown;labor?:unknown}|null;
      const choose=(input:unknown)=>typeof input==="boolean"?input:null;
      return {available:true,value:{menus:choose(parsed?.menus),labor:choose(parsed?.labor)},
        quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}};
    },
    async(requested)=>{
      assertBusiness(requested);
      const {data,error}=await client.from("pos_import_reviews")
        .select("review_type,source_key,detail")
        .eq("business_id",requested).eq("provider","toast")
        .eq("status","needs_owner")
        .in("review_type",["staff_identity","unlinked_timecard",
          "overlapping_timecard","shift_corrected"])
        .order("created_at",{ascending:false}).limit(51);
      if(error){
        if(["42P01","PGRST205"].includes(error.code??""))
          return {available:false,value:null,quality:{level:"low" as const,
            missingInputs:["posImportReviewsMigrationPending"],estimatedInputs:[],staleInputs:[]}};
        throw error;
      }
      const truncated=(data??[]).length>50;
      return {available:true,value:(data??[]).slice(0,50).map(row=>({
        reviewType:row.review_type,sourceKey:row.source_key,
        detail:row.detail&&typeof row.detail==="object"&&!Array.isArray(row.detail)?
         row.detail as Record<string,unknown>:{}
      })),quality:{level:truncated?"medium" as const:"high" as const,
        missingInputs:truncated?["morePosReviews"]:[],estimatedInputs:[],staleInputs:[]}};
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
