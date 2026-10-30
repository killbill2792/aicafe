import "server-only";
import {cache} from "react";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { getFixtureSnapshot } from "./fixtureSnapshot";
import { getBusinessSnapshotFromDb } from "./snapshot.server";
import {getOptionalAuthenticatedUser} from "@/lib/auth/requireUser";
import type { BusinessSnapshot } from "./types";
import {timeReader} from "@/lib/perf/timeReader.server";

/**
 * Single entry point every screen uses. Falls back to the Fixture-A-derived snapshot when
 * Supabase isn't connected (so the app is fully browsable/demoable before M1's credentials
 * exist) or when the signed-in user isn't resolvable; otherwise queries the real business.
 */
export async function getSnapshot(
  costPeriod:"today"|"week"|"month"="month"):Promise<BusinessSnapshot>{
  return getSnapshotCached(costPeriod);
}
const getSnapshotCached=cache(async function getSnapshotCached(
  costPeriod:"today"|"week"|"month"="month"):Promise<BusinessSnapshot>{
  if (!isSupabaseConfigured()) return getFixtureSnapshot();

  const [supabase,user] = await Promise.all([
    createServerSupabaseClient(),
    timeReader("Snapshot","auth",getOptionalAuthenticatedUser),
  ]);
  if (!user) return getFixtureSnapshot();

  const businessId = await timeReader("Snapshot","activeBusinessId",()=>getActiveBusinessId(user.id));
  return timeReader("Snapshot","businessData",()=>getBusinessSnapshotFromDb(supabase,businessId,costPeriod));
});
