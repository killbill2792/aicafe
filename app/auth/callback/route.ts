import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/** Magic-link landing page: exchanges the emailed code for a session, then sends the owner home. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const requestedLocale = searchParams.get("locale");
  const locale = requestedLocale === "es" || requestedLocale === "ar" ? requestedLocale : "en";
  const candidate = searchParams.get("next") ?? `/${locale}`;
  // Only allow app-local destinations; no open redirects after authentication.
  const next = candidate.startsWith(`/${locale}`) && !candidate.startsWith("//") && !candidate.includes("\\") && !candidate.includes("%") ? candidate : `/${locale}`;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (code && supabaseUrl && supabaseAnonKey) {
    const cookieStore = await cookies();
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        },
      },
    });
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/${locale}/login?error=auth`);
}
