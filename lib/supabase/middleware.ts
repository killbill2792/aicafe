import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase auth session on every request and mirrors any updated
 * cookies onto `response` (which may already carry a next-intl rewrite/redirect —
 * see proxy.ts). Must run before any Server Component reads the session.
 */
export async function refreshSupabaseSession(request: NextRequest, response: NextResponse) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    // No Supabase project configured yet (pre-M1 setup) — skip rather than throw,
    // so the app still runs to show empty/demo screens.
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        // Prevent a CDN from caching a response carrying another owner's refreshed session.
        if (headers) {
          for (const [key, value] of Object.entries(headers)) {
            if (value) response.headers.set(key, String(value));
          }
        }
      },
    },
  });

  await supabase.auth.getUser();
  return response;
}
