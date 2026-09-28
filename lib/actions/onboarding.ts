"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { DEFAULT_RECOVERY_ORDER } from "@/lib/constants";

/**
 * Creates the signed-in user's own business on first visit to onboarding, if they don't have one
 * yet. Uses the admin (service-role) client deliberately: RLS's `is_member()` check can't pass
 * for an INSERT into `businesses` before any membership row exists — this is the one place that
 * chicken-and-egg needs bypassing (see docs/04-data-model.md's RLS pattern).
 *
 * Deliberately never touches the active-business cookie: this is called directly from
 * `onboarding/page.tsx`'s render body (not from a submitted form), and Next.js throws if a
 * Server Component render path tries to set a cookie — only an actual Server Action invocation
 * or Route Handler may. It doesn't need to: `getActiveBusinessId()` already prefers a user's own
 * (non-demo) business over the demo one whenever no cookie is set, so a fresh business created
 * here becomes the active one automatically. The explicit switcher (`setActiveBusinessCookie`)
 * is a real form-invoked Server Action and is unaffected by this.
 */
export async function ensureOwnBusiness(): Promise<{ businessId: string } | { error: string }> {
  if (!isSupabaseConfigured()) return { error: "Connect Supabase first (see PROGRESS.md)." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in first." };

  const { data: memberships } = await supabase.from("memberships").select("business_id, businesses(is_demo)").eq("user_id", user.id);
  const own = (memberships ?? []).find((m) => {
    const b = m.businesses as unknown as { is_demo: boolean } | { is_demo: boolean }[] | null;
    const isDemo = Array.isArray(b) ? b[0]?.is_demo : b?.is_demo;
    return isDemo === false;
  });
  if (own) {
    return { businessId: own.business_id };
  }

  const admin = createAdminSupabaseClient();
  const { data: business, error: businessError } = await admin
    .from("businesses")
    .insert({ name: "My café", is_demo: false })
    .select("id")
    .single();
  if (businessError || !business) return { error: businessError?.message ?? "Could not create your business." };

  const { error: membershipError } = await admin
    .from("memberships")
    .insert({ business_id: business.id, user_id: user.id, role: "owner", can_see_profit: true });
  if (membershipError) return { error: membershipError.message };

  await admin.from("recovery_order").insert(DEFAULT_RECOVERY_ORDER.map((code, i) => ({ business_id: business.id, bucket_code: code, position: i })));

  return { businessId: business.id };
}

export async function setPayrollTaxRate(ratePercent: number): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Sign in first." };
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const result = await ensureOwnBusiness();
  if ("error" in result) return { ok: false, error: result.error };

  const { error } = await supabase
    .from("businesses")
    .update({ payroll_tax_rate: ratePercent / 100 })
    .eq("id", result.businessId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/onboarding");
  return { ok: true };
}
