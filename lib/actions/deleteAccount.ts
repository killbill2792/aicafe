"use server";

import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/security/tokenCrypto";
import { squareApiBaseUrl } from "@/lib/pos/square/oauth";
import { DEMO_BUSINESS_ID } from "@/lib/constants";

/**
 * docs/06-integrations.md "Security": "Delete account = delete business data, files, and revoke
 * the Square token." Only ever touches the user's own business — never the shared demo café.
 * Best-effort on the Square revoke and storage cleanup (a failed revoke shouldn't block deleting
 * the person's data); the business row delete is what actually matters and always runs last.
 */
export async function deleteAccount(): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Not connected." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const admin = createAdminSupabaseClient();

  const { data: memberships } = await supabase.from("memberships").select("business_id, businesses(is_demo)").eq("user_id", user.id);
  const ownBusinessIds = (memberships ?? [])
    .filter((m) => {
      const b = m.businesses as unknown as { is_demo: boolean } | { is_demo: boolean }[] | null;
      const isDemo = Array.isArray(b) ? b[0]?.is_demo : b?.is_demo;
      return isDemo === false;
    })
    .map((m) => m.business_id)
    .filter((id) => id !== DEMO_BUSINESS_ID);

  for (const businessId of ownBusinessIds) {
    const { data: squareConnection } = await admin
      .from("pos_connections")
      .select("access_token_enc")
      .eq("business_id", businessId)
      .eq("provider", "square")
      .maybeSingle();
    if (squareConnection?.access_token_enc) {
      try {
        const accessToken = decryptToken(squareConnection.access_token_enc);
        await fetch(`${squareApiBaseUrl()}/oauth2/revoke`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Client ${process.env.SQUARE_APPLICATION_SECRET ?? ""}`,
            "Square-Version": "2025-05-21",
          },
          body: JSON.stringify({ client_id: process.env.SQUARE_APPLICATION_ID, access_token: accessToken }),
        });
      } catch (err) {
        console.error("[deleteAccount] Square token revoke failed (continuing)", err);
      }
    }

    try {
      const { data: files } = await admin.storage.from("uploads").list(businessId);
      if (files && files.length > 0) {
        await admin.storage.from("uploads").remove(files.map((f) => `${businessId}/${f.name}`));
      }
    } catch (err) {
      console.error("[deleteAccount] storage cleanup failed (continuing)", err);
    }

    // Cascades to every child row (orders, expenses, timecards, ...) per docs/04-data-model.md's
    // `on delete cascade` foreign keys.
    await admin.from("businesses").delete().eq("id", businessId);
  }

  const { error: authError } = await admin.auth.admin.deleteUser(user.id);
  if (authError) return { ok: false, error: authError.message };

  return { ok: true };
}
