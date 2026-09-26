"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ACTIVE_BUSINESS_COOKIE } from "@/lib/data/getActiveBusinessId";

/** Settings → "Demo café" / "My café" switch (docs/03-screens.md S12). Never mixes the two — this
 * just changes which business_id every screen's queries filter by. */
export async function setActiveBusinessCookie(businessId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const { data: membership } = await supabase.from("memberships").select("business_id").eq("user_id", user.id).eq("business_id", businessId).maybeSingle();
  if (!membership) return { ok: false, error: "You don't have access to that business." };

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_BUSINESS_COOKIE, businessId, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365, path: "/" });

  revalidatePath("/");
  revalidatePath("/money");
  revalidatePath("/menu");
  revalidatePath("/more");
  return { ok: true };
}
