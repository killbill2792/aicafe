import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { exchangeCodeForToken, squareApiBaseUrl } from "@/lib/pos/square/oauth";
import { encryptToken } from "@/lib/security/tokenCrypto";
import { createSquareAdapter } from "@/lib/pos/square/adapter";
import { syncPosData } from "@/lib/pos/sync";
import { STATE_COOKIE } from "../connect/route";

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

  try {
    const token = await exchangeCodeForToken(code);

    // A merchant can have several locations; use the first (v1 assumption — docs/04-data-model.md
    // has one `locations` row per business for now). Confirm against a real sandbox account.
    const locationsRes = await fetch(`${squareApiBaseUrl()}/v2/locations`, {
      headers: { authorization: `Bearer ${token.access_token}`, "Square-Version": "2025-05-21" },
    });
    const locationsData = await locationsRes.json();
    const squareLocationId: string | undefined = locationsData?.locations?.[0]?.id;
    const locationName: string = locationsData?.locations?.[0]?.name ?? "Main";
    if (!squareLocationId) throw new Error("Square account has no locations");

    const { data: location } = await supabase
      .from("locations")
      .upsert(
        { business_id: businessId, name: locationName, pos_location_id: squareLocationId },
        { onConflict: "business_id,pos_location_id" },
      )
      .select("id")
      .single();

    await supabase.from("pos_connections").upsert(
      {
        business_id: businessId,
        provider: "square",
        merchant_id: token.merchant_id,
        access_token_enc: encryptToken(token.access_token),
        refresh_token_enc: encryptToken(token.refresh_token),
        token_expires_at: token.expires_at,
        status: "active",
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "business_id,provider" },
    );

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

    await supabase.from("pos_connections").update({ backfill_completed_at: new Date().toISOString() }).eq("business_id", businessId).eq("provider", "square");

    return NextResponse.redirect(`${origin}/${locale}/onboarding?step=2`);
  } catch (err) {
    console.error("[square/callback] failed", err);
    return redirectHome("?error=connection_failed");
  }
}
