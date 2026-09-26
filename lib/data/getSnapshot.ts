import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { getFixtureSnapshot } from "./fixtureSnapshot";
import { getBusinessSnapshotFromDb } from "./snapshot.server";
import type { BusinessSnapshot } from "./types";

/**
 * Single entry point every screen uses. Falls back to the Fixture-A-derived snapshot when
 * Supabase isn't connected (so the app is fully browsable/demoable before M1's credentials
 * exist) or when the signed-in user isn't resolvable; otherwise queries the real business.
 */
export async function getSnapshot(): Promise<BusinessSnapshot> {
  if (!isSupabaseConfigured()) return getFixtureSnapshot();

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return getFixtureSnapshot();

  const businessId = await getActiveBusinessId(user.id);
  return getBusinessSnapshotFromDb(supabase, businessId);
}
