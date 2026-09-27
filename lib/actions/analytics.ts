"use server";

import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";

/** Logs one screen view for the signed-in user's active business. No-ops when Supabase isn't
 * configured or nobody is signed in — anonymous pages (e.g. /login, /privacy) aren't logged. */
export async function logScreenView(path: string): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const businessId = await getActiveBusinessId(user.id);
  await supabase.from("screen_views").insert({ business_id: businessId, user_id: user.id, path });
}
