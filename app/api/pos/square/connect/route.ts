import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { buildAuthorizeUrl, isSquareConfigured } from "@/lib/pos/square/oauth";

export const STATE_COOKIE = "square_oauth_state";

/** Step 1 of onboarding (docs/03-screens.md S2): "Connect Square" sends the owner here. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const locale = searchParams.get("locale") ?? "en";

  if (!isSquareConfigured()) {
    return NextResponse.redirect(`${origin}/${locale}/onboarding?error=square_not_configured`);
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/${locale}/login`);

  const state = randomBytes(16).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  cookieStore.set("square_oauth_locale", locale, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });

  return NextResponse.redirect(buildAuthorizeUrl(state));
}
