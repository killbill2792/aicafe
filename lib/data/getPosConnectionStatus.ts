import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";

type ConnectionStatusValue = "active" | "needs_reconnect" | "disconnected";
export type PosConnectionStatus = { provider: string; status: ConnectionStatusValue } | null;

/** docs/03-screens.md "Global states": POS disconnected shows a warn banner with Reconnect. */
export async function getPosConnectionStatus(): Promise<PosConnectionStatus> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const businessId = await getActiveBusinessId(user.id);

  const { data } = await supabase.from("pos_connections").select("provider, status").eq("business_id", businessId).maybeSingle();
  if (!data) return null;
  return { provider: data.provider, status: data.status as ConnectionStatusValue };
}
