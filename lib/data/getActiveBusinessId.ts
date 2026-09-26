import "server-only";
import { cookies } from "next/headers";
import { DEMO_BUSINESS_ID } from "@/lib/constants";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const ACTIVE_BUSINESS_COOKIE = "active_business_id";

/**
 * Which business the signed-in user is currently viewing — their own real café, or the shared
 * Demo café (Settings → "Demo café" / "My café" switch, docs/03-screens.md S12). Defaults to the
 * user's own business once they have one, otherwise the demo. Trusts only businesses the user is
 * actually a member of (RLS would block anything else regardless, but this avoids a wasted query).
 */
export async function getActiveBusinessId(userId: string): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const { data: memberships } = await supabase
    .from("memberships")
    .select("business_id, businesses(is_demo)")
    .eq("user_id", userId);

  const rows = memberships ?? [];
  if (rows.length === 0) return DEMO_BUSINESS_ID;

  const cookieStore = await cookies();
  const requested = cookieStore.get(ACTIVE_BUSINESS_COOKIE)?.value;
  if (requested && rows.some((r) => r.business_id === requested)) return requested;

  const ownBusiness = rows.find((r) => {
    const business = r.businesses as unknown as { is_demo: boolean } | { is_demo: boolean }[] | null;
    const isDemo = Array.isArray(business) ? business[0]?.is_demo : business?.is_demo;
    return isDemo === false;
  });
  return ownBusiness?.business_id ?? DEMO_BUSINESS_ID;
}
