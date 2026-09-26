"use server";

import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function setAlertStatus(alertId: string, status: "seen" | "resolved" | "dismissed"): Promise<{ ok: boolean }> {
  if (!isSupabaseConfigured()) return { ok: false };
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("alerts").update({ status }).eq("id", alertId);
  revalidatePath("/more/alerts");
  revalidatePath("/");
  return { ok: !error };
}

/** Same as setAlertStatus but void-returning, for direct use as a <form action={...}>. */
export async function markAlertStatus(alertId: string, status: "seen" | "resolved" | "dismissed"): Promise<void> {
  await setAlertStatus(alertId, status);
}
