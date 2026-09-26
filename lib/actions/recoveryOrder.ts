"use server";

import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";

/** Moves `bucketCode` one spot earlier/later in the cost-recovery payment order (docs/03-screens.md S4). */
export async function moveRecoveryBucket(direction: "up" | "down", bucketCode: string) {
  if (!isSupabaseConfigured()) return; // fixture mode has nothing to persist to

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const businessId = await getActiveBusinessId(user.id);
  const { data: rows, error } = await supabase
    .from("recovery_order")
    .select("bucket_code, position")
    .eq("business_id", businessId)
    .order("position", { ascending: true });
  if (error || !rows) return;

  const index = rows.findIndex((r) => r.bucket_code === bucketCode);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || swapWith < 0 || swapWith >= rows.length) return;

  const a = rows[index];
  const b = rows[swapWith];
  await Promise.all([
    supabase.from("recovery_order").update({ position: b.position }).eq("business_id", businessId).eq("bucket_code", a.bucket_code),
    supabase.from("recovery_order").update({ position: a.position }).eq("business_id", businessId).eq("bucket_code", b.bucket_code),
  ]);

  revalidatePath("/money");
  revalidatePath("/");
}
