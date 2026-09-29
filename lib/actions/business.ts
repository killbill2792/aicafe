"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DEMO_BUSINESS_ID } from "@/lib/constants";

export type ActionResult = { ok: true } | { ok: false; error: string };

const NameSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
});

/** Renames the owner's own café — every new business is created with the placeholder "My café"
 * (see lib/actions/onboarding.ts) and had no way to ever change it. Never allowed on the shared
 * demo business, which every account has membership on but nobody owns. */
export async function updateBusinessName(input: z.infer<typeof NameSchema>): Promise<ActionResult> {
  const parsed = NameSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a name." };
  if (parsed.data.businessId === DEMO_BUSINESS_ID) return { ok: false, error: "Can't rename the demo café." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const { data: membership } = await supabase
    .from("memberships")
    .select("business_id")
    .eq("user_id", user.id)
    .eq("business_id", parsed.data.businessId)
    .maybeSingle();
  if (!membership) return { ok: false, error: "You don't have access to that business." };

  const { error } = await supabase.from("businesses").update({ name: parsed.data.name }).eq("id", parsed.data.businessId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/");
  revalidatePath("/money");
  revalidatePath("/menu");
  revalidatePath("/more");
  return { ok: true };
}
