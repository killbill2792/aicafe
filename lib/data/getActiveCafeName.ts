import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getFixtureSnapshot } from "./fixtureSnapshot";
import {getActiveBusinessId,readActiveBusinessMemberships} from "./getActiveBusinessId";
import { getOptionalAuthenticatedUser } from "@/lib/auth/requireUser";

/** Navigation identity must follow the same authorized active-business selector as getSnapshot(). */
export async function getActiveCafeName(): Promise<string> {
  const fallback = getFixtureSnapshot().business.name;
  if (!isSupabaseConfigured()) return fallback;
  const supabase = await createServerSupabaseClient();
  const user = await getOptionalAuthenticatedUser();
  if (!user) return fallback;
  const memberships=await readActiveBusinessMemberships(user.id);
  const hasReal=memberships.some(row=>{
    const b=row.businesses as unknown as {is_demo:boolean}|{is_demo:boolean}[]|null;
    return (Array.isArray(b)?b[0]?.is_demo:b?.is_demo)===false;
  });
  if(!hasReal)return "Set up your café";
  const businessId=await getActiveBusinessId(user.id);
  const { data, error } = await supabase.from("businesses")
    .select("name").eq("id", businessId).maybeSingle();
  if (error) throw error;
  return data?.name?.trim() || fallback;
}
