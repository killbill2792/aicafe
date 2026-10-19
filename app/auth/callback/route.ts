import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authFlow, authLocale, authTokenType, safeCallbackDestination, tokenDestination } from "@/lib/auth/callbackUtils";

/** Backward-compatible PKCE callback for existing magic links and email confirmations. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const locale = authLocale(searchParams.get("locale"));
  const flow = authFlow(searchParams.get("flow"));
  const next = safeCallbackDestination(locale, searchParams.get("next"), flow);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const tokenType = authTokenType(searchParams.get("type"));
  const url = new URL(next, origin);
  const fallback = new URL(`/${locale}/login?error=auth`, origin);
  if ((!code && !(tokenHash && tokenType)) || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return NextResponse.redirect(fallback, { headers: { "Cache-Control": "no-store" } });
  }

  const response = NextResponse.redirect(tokenHash && tokenType ? new URL(tokenDestination(locale, tokenType), origin) : url);
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
  try {
    const { error } = tokenHash && tokenType
      ? await supabase.auth.verifyOtp({ type: tokenType, token_hash: tokenHash })
      : await supabase.auth.exchangeCodeForSession(code!);
    return error ? NextResponse.redirect(fallback, { headers: { "Cache-Control": "no-store" } }) : response;
  } catch {
    return NextResponse.redirect(fallback, { headers: { "Cache-Control": "no-store" } });
  }