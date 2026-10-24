"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function setAlertStatus(alertId: string, status: "seen" | "resolved" | "dismissed"): Promise<{ ok: boolean }> {
  if (!isSupabaseConfigured()) return { ok: false };
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  const businessId = await getActiveBusinessId(user.id);
  const { data, error } = await supabase.from("alerts")
    .update({ status })
    .eq("business_id", businessId)
    .eq("id", alertId)
    .in("status", ["new", "seen"])
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
