import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getFixtureSnapshot } from "./fixtureSnapshot";
import { getActiveBusinessId } from "./getActiveBusinessId";

/** Navigation identity must follow the same authorized active-business selector as getSnapshot(). */
export async function getActiveCafeName(): Promise<string> {
  const fallback = getFixtureSnapshot().business.name;
  if (!isSupabaseConfigured()) return fallback;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fallback;
  const businessId = await getActiveBusinessId(user.id);
  const { data, error } = await supabase.from("businesses")
    .select("name").eq("id", businessId).maybeSingle();
  if (error) throw error;
  return data?.name?.trim() || fallback;
}
