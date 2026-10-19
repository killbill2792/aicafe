import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authLocale, authTokenType, tokenDestination } from "@/lib/auth/callbackUtils";

/** Token-hash confirmation works even if the email opens on a different browser/device. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const locale = authLocale(searchParams.get("locale"));
  const tokenHash = searchParams.get("token_hash");
  const type = authTokenType(searchParams.get("type"));
  const fallback = new URL(`/${locale}/login?error=auth`, origin);
  if (!tokenHash || !type || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return NextResponse.redirect(fallback);
  }

  const response = NextResponse.redirect(new URL(tokenDestination(locale, type), origin));
  const cookieStore = await cookies();
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options);
          response.cookies.set(name, value, options);
        });
        if (headers) {
          for (const [key, value] of Object.entries(headers)) {
            if (value) response.headers.set(key, String(value));
          }
        }
      },
    },
  });
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  return error ? NextResponse.redirect(fallback) : response;
}
