import "server-only";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { TeamUpdate, TeamUpdateStatus } from "@/lib/teamUpdates/contracts";

export type MonitorUpdateLease={initiativeId:string;token:string;evidenceRevision:number};
export type NewTeamUpdate = Pick<TeamUpdate,
  "business_id" | "owner_user_id" | "agent_id" | "domain" | "kind" | "severity" |
  "subject_type" | "subject_id" | "facts" | "text" | "locale" | "actions" | "dedupe_key"
>;

/** Data access boundary: service-role writes still require a real owner membership. */
export async function insertTeamUpdate(row: NewTeamUpdate,
  signal?:AbortSignal,lease?:MonitorUpdateLease): Promise<boolean> {
  const db = createAdminSupabaseClient(signal);
  if(lease){
    const {data,error}=await db.rpc("insert_monitor_team_update_fenced",{
      p_initiative_id:lease.initiativeId,p_token:lease.token,
      p_evidence_revision:lease.evidenceRevision,p_row:row,
    });
    if(error)throw error;
    if(data==="stale")throw new Error("monitor evidence lease superseded");
    if(data!=="created"&&data!=="duplicate")
      throw new Error("monitor notification persistence unavailable");
    return data==="created";
  }
  const { data: membership, error: membershipError } = await db.from("memberships")
    .select("user_id").eq("business_id", row.business_id)
    .eq("user_id", row.owner_user_id).eq("role", "owner").maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new Error("Team update owner membership required");

  const { data, error } = await db.from("team_updates")
    .upsert(row, { onConflict: "business_id,dedupe_key", ignoreDuplicates: true })
    .select("id").maybeSingle();
  if (error) throw error;
  return data !== null;
}

async function ownerSession(businessId?: string) {
  const db = await createServerSupabaseClient();
  const { data: { user }, error } = await db.auth.getUser();
  if (error || !user) throw new Error("Authenticated owner required");
  if (businessId) {
    const { data: membership, error: membershipError } = await db.from("memberships")
      .select("user_id").eq("business_id", businessId)
      .eq("user_id", user.id).eq("role", "owner").maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership) throw new Error("Owner membership required");
  }
  return { db, ownerId: user.id };
}

/** Session-backed reads obey owner_user_id and database RLS. */
export async function selectTeamUpdates(
  businessId: string, limit: number, status?: TeamUpdateStatus,
): Promise<TeamUpdate[]> {
  const { db, ownerId } = await ownerSession(businessId);
  let query = db.from("team_updates").select("*")
    .eq("business_id", businessId).eq("owner_user_id", ownerId);
  if (status) query = query.eq("status", status);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as TeamUpdate[];
}

/** Database UPDATE privilege is deliberately limited to status. */
export async function updateTeamUpdateStatus(id: string, status: TeamUpdateStatus): Promise<void> {
  const { db, ownerId } = await ownerSession();
  const { data, error } = await db.from("team_updates")
    .update({ status }).eq("id", id).eq("owner_user_id", ownerId)
    .select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Team update not found or access denied");
}
