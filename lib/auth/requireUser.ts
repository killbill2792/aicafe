import "server-only";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/client";

/**
 * Server-side guard for every authenticated tab screen. Redirects to /login when signed out.
 * Before Supabase is connected (see PROGRESS.md "Needs connecting"), this is a no-op so the
 * rest of the app stays browsable instead of crashing.
 */
export async function requireUser() {
  if (!isSupabaseConfigured()) return null;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const locale = await getLocale();
    redirect(`/${locale}/login`);
  }

  return user;
}
