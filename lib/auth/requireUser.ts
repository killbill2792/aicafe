import "server-only";
import {cache} from "react";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/client";

/**
 * Server-side guard for every authenticated tab screen. Redirects to /login when signed out.
 * Before Supabase is connected (see PROGRESS.md "Needs connecting"), this is a no-op so the
 * rest of the app stays browsable instead of crashing.
 */
/** Shared per-request auth fact for Home, Money and alerts. */
export const getOptionalAuthenticatedUser=cache(async function getOptionalAuthenticatedUser(){
  if(!isSupabaseConfigured())return null;
  const supabase=await createServerSupabaseClient();
  const {data:{user},error}=await supabase.auth.getUser();
  if(error)return null;
  return user;
});
export const requireUser=cache(async function requireUser(){
  const user=await getOptionalAuthenticatedUser();
  if(!user&&isSupabaseConfigured()){
    const locale = await getLocale();
    redirect(`/${locale}/login`);
  }

  return user;
});

/**
 * Same as requireUser(), plus: sends a signed-in owner straight to onboarding until they've set
 * up their own café. Every new user is auto-granted membership on the shared Demo café (see
 * PROGRESS.md decisions) so they can explore it deliberately from the More → café switcher — but
 * without this guard, a brand-new real signer-in would silently land on Home showing the *demo*
 * café's real seeded data with no indication it isn't theirs (a real café owner hit exactly this
 * the first time this app ever had a real user sign up), and any action they took (add a cost, log
 * staff hours, reorder bills) would write into the shared demo business instead of going nowhere.
 * Use this instead of requireUser() on every screen that reads or writes business data; keep
 * plain requireUser() only on /onboarding itself, /more (needs to stay reachable to get *to*
 * onboarding and to sign out), and /more/delete-account.
 */
export const requireOwnBusiness=cache(async function requireOwnBusiness(){
  const user = await requireUser();
  if (!isSupabaseConfigured() || !user) return user;

  const supabase = await createServerSupabaseClient();
  const { data: memberships } = await supabase.from("memberships").select("business_id, businesses(is_demo)").eq("user_id", user.id);
  const hasOwnBusiness = (memberships ?? []).some((m) => {
    const business = m.businesses as unknown as { is_demo: boolean } | { is_demo: boolean }[] | null;
    const isDemo = Array.isArray(business) ? business[0]?.is_demo : business?.is_demo;
    return isDemo === false;
  });

  if (!hasOwnBusiness) {
    const locale = await getLocale();
    redirect(`/${locale}/onboarding`);
  }

  return user;
});
