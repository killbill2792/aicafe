import "server-only";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { teamUpdateStatusSchema, type TeamUpdate, type TeamUpdateStatus } from "./contracts";

const listOptionsSchema = z.object({
  limit: z.number().int().min(1).max(20).default(20),
  status: teamUpdateStatusSchema.optional(),
}).strict();

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

export async function listTeamUpdates(
  businessId: string,
  options: { limit?: number; status?: TeamUpdateStatus } = {},
): Promise<TeamUpdate[]> {
  const id = z.string().uuid().parse(businessId);
  const { limit, status } = listOptionsSchema.parse(options);
  const { db, ownerId } = await ownerSession(id);
  let query = db.from("team_updates").select("*")
    .eq("business_id", id).eq("owner_user_id", ownerId);
  if (status) query = query.eq("status", status);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as TeamUpdate[];
}

/** Only status is writable by authenticated owners (enforced in SQL). */
export async function setTeamUpdateStatus(id: string, status: TeamUpdateStatus): Promise<void> {
  const updateId = z.string().uuid().parse(id);
  const nextStatus = teamUpdateStatusSchema.parse(status);
  const { db, ownerId } = await ownerSession();
  const { data, error } = await db.from("team_updates").update({ status: nextStatus })
    .eq("id", updateId).eq("owner_user_id", ownerId).select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Team update not found or access denied");
}
