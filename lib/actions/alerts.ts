"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { DEMO_BUSINESS_ID } from "@/lib/constants";
import { withOwnerDisposition } from "@/lib/alerts/reconcile";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function setAlertStatus(alertId: string, status: "seen" | "resolved" | "dismissed"): Promise<{ ok: boolean }> {
  if (!isSupabaseConfigured()) return { ok: false };
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  const businessId = await getActiveBusinessId(user.id);
  // Shared demo is readable but no viewer may change alert status for everyone else.
  if (businessId === DEMO_BUSINESS_ID) return { ok: false };

  // Capture the original incident payload before an owner disposition, rather than
  // overwriting the dedupe key or mistaking automatic resolution for the owner's Done.
  const { data: current, error: readError } = await supabase.from("alerts")
    .select("status, payload")
    .eq("business_id", businessId)
    .eq("id", alertId)
    .in("status", ["new", "seen"])
    .maybeSingle();
  if (readError || !current) return { ok: false };

  const patch = status === "seen"
    ? { status }
    : { status, payload: withOwnerDisposition(current.payload) };
  const { data, error } = await supabase.from("alerts")
    .update(patch)
    .eq("business_id", businessId)
    .eq("id", alertId)
    // A generator or another owner action may have changed state after our read.
    .eq("status", current.status)
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false };
  revalidatePath("/more/alerts");
  revalidatePath("/");
  return { ok: true };
}

/** Same as setAlertStatus but void-returning, for direct use as a <form action={...}>. */
export async function markAlertStatus(alertId: string, status: "seen" | "resolved" | "dismissed"): Promise<void> {
  const result = await setAlertStatus(alertId, status);
  if (result.ok && status !== "seen") {
    const locale = await getLocale();
    redirect(`/${locale}/more/alerts`);
  }
}
