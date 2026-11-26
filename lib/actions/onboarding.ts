"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { DEFAULT_RECOVERY_ORDER } from "@/lib/constants";
import {isLinkedStaffUser} from "@/lib/staffCommunication/identity.server";

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
  // Service-role café creation must never be reachable through a worker
  // login, even when invoked as a server action without rendering the page.
  if(await isLinkedStaffUser(user.id))
    return {error:"staff_account_restricted"};

  const admin = createAdminSupabaseClient();
  // Registration metadata is display input only; the authenticated user determines ownership.
  const requestedName = typeof user.user_metadata?.cafe_name === "string" ? user.user_metadata.cafe_name.trim().slice(0, 80) : "";
  // One database transaction serializes onboarding for the same authenticated
  // user across requests and server instances. Membership and default recovery
  // order are committed with the business or rolled back together.
  const {data:businessId,error}=await admin.rpc("ensure_owner_onboarding_business",{
    p_owner_user_id:user.id,p_name:requestedName||"My café",p_recovery_order:DEFAULT_RECOVERY_ORDER,
  });
  if(error||typeof businessId!=="string")return {error:error?.message??"Could not create your business."};
  return {businessId};
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
