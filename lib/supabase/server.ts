import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Server-side client for use in Server Components/actions.
 * Uses the anon key so RLS still applies. Cookie-based session forwarding
 * (via @supabase/ssr) is wired up in M1 alongside magic-link/OTP login.
 */
export function createServerSupabaseClient() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Copy .env.local.example to .env.local and fill them in.",
    );
  }
  return createClient(supabaseUrl, supabaseAnonKey);
}
