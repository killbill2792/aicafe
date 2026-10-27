import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { exchangeCodeForToken, squareApiBaseUrl } from "@/lib/pos/square/oauth";
import { encryptToken } from "@/lib/security/tokenCrypto";
import { createSquareAdapter } from "@/lib/pos/square/adapter";
import { syncPosData } from "@/lib/pos/sync";
import {STATE_COOKIE} from "@/lib/pos/square/oauthState";

/** Step 1 of onboarding, continued: Square redirects back here with a code (or an error). */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const cookieStore = await cookies();
  const locale = cookieStore.get("square_oauth_locale")?.value ?? "en";
  const redirectHome = (query = "") => NextResponse.redirect(`${origin}/${locale}/onboarding${query}`);

  const error = searchParams.get("error");
  if (error) return redirectHome(`?error=${encodeURIComponent(error)}`);

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expectedState = cookieStore.get(STATE_COOKIE)?.value;
  if (!code || !state || !expectedState || state !== expectedState) {
    return redirectHome("?error=invalid_state");
  }
  cookieStore.delete(STATE_COOKIE);

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/${locale}/login`);
  const businessId = await getActiveBusinessId(user.id);
  const {data:member,error:membershipError}=await supabase.from("memberships")
    .select("role").eq("user_id",user.id).eq("business_id",businessId).maybeSingle();
  if(membershipError||member?.role!=="owner")
    return redirectHome("?error=owner_required");

  try {
    const token = await exchangeCodeForToken(code);

    // A merchant can have several locations; use the first (v1 assumption — docs/04-data-model.md
    // has one `locations` row per business for now). Confirm against a real sandbox account.
    const locationsRes = await fetch(`${squareApiBaseUrl()}/v2/locations`, {
      headers: { authorization: `Bearer ${token.access_token}`, "Square-Version": "2025-05-21" },
    });
    const locationsData = await locationsRes.json();
    const squareLocationId: string | undefined = locationsData?.locations?.[0]?.id;
    const posLocation=locationsData?.locations?.[0];
    const locationName: string = posLocation?.name ?? "Main";
    if (!squareLocationId) throw new Error("Square account has no locations");

    // A global uniqueness constraint protects another café's location even
    // though RLS correctly prevents querying another owner's private rows.
     const { data: location,error:locationError } = await supabase
      .from("locations")
      .upsert(
        { business_id: businessId, name: locationName, pos_location_id: squareLocationId },
        { onConflict: "business_id,pos_location_id" },
      )
      .select("id")
      .single();
    if(locationError){
      if(locationError.code==="23505")return redirectHome("?error=square_location_already_linked");
      throw locationError;
    }
    if(!location)throw new Error("Square location could not be linked");
     const {error:connectionError}=await supabase.from("pos_connections").upsert(
      {
        business_id: businessId,
        provider: "square",
        merchant_id: token.merchant_id,
        access_token_enc: encryptToken(token.access_token),
        refresh_token_enc: encryptToken(token.refresh_token),
        token_expires_at: token.expires_at,
        status: "active",
        // Connection is authorized, but sales are not proven synced until
        // syncPosData finishes; old backfills must never survive re-link.
        last_synced_at: null,
        backfill_completed_at: null,
      },
      { onConflict: "business_id,provider" },
    );

    if(connectionError)throw connectionError;

    // POS-local timezone and hours fill unset café values only. Owner-provided
    // hours are never overwritten; conflicting POS values need explicit review.
    const {data:currentBusiness,error:businessLoadError}=await supabase.from("businesses")
      .select("timezone").eq("id",businessId).single();
    if(businessLoadError)throw businessLoadError;
    if(!currentBusiness?.timezone&&posLocation?.timezone){
      const {error:tzError}=await supabase.from("businesses").update({
        timezone:posLocation.timezone
      }).eq("id",businessId).is("timezone",null);
      if(tzError)throw tzError;
    }
    const {data:site,error:siteError}=await supabase.from("locations").select("open_hours")
      .eq("id",location.id).eq("business_id",businessId).single();
    if(siteError)throw siteError;
    if(!site?.open_hours&&posLocation?.business_hours?.periods){
      const days=["sun","mon","tue","wed","thu","fri","sat"];
      const hours:Record<string,Array<[string,string]>>={};
      for(const period of posLocation.business_hours.periods){
        const key=String(period.day_of_week??"").trim().toLowerCase().slice(0,3);
        if(!days.includes(key))continue;
        if(!period.start_local_time||!period.end_local_time)continue;
        (hours[key]??=[]).push([period.start_local_time.slice(0,5),period.end_local_time.slice(0,5)]);
      }
      const {error:hoursError}=await supabase.from("locations").update({
        open_hours:hours
      }).eq("id",location.id).eq("business_id",businessId).is("open_hours",null);
      if(hoursError)throw hoursError;
    }

    // Backfill: last 90 days (docs/06-integrations.md). Runs inline for now — move to a background
    // job before pilot if 90 days of real order volume risks the route handler's time limit.
    const { data: business } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
    const adapter = createSquareAdapter({ accessToken: token.access_token, locationId: squareLocationId });
    const until = new Date();
    const since = new Date(until.getTime() - 90 * 24 * 60 * 60 * 1000);
    await syncPosData(supabase, {
      businessId,
      locationId: location?.id ?? squareLocationId,
      timezone: business?.timezone ?? "America/Los_Angeles",
      adapter,
      since,
      until,
    });

    const {error:completedError}=await supabase.from("pos_connections").update({
      backfill_completed_at:new Date().toISOString(),last_synced_at:new Date().toISOString()
    }).eq("business_id",businessId).eq("provider","square");
    if(completedError)throw completedError;

    return NextResponse.redirect(`${origin}/${locale}/onboarding?step=2`);
  } catch {
    // Errors may include Square's authorization details. Log only the safe
    // category; never tokens, claims, or provider response bodies.
    console.error("[square/callback] connection_failed");
    return redirectHome("?error=connection_failed");
  }
}
