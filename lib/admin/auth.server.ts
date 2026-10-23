import "server-only";
import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isAdminEmail } from "./access";

/** Always check the authenticated identity on the server, before any privileged read.
 * The role allowlist is never sent to the browser. */
export async function requireAdmin() {
  if (!process.env.ADMIN_EMAILS) notFound();
  const client = await createServerSupabaseClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user || !isAdminEmail(user.email, process.env.ADMIN_EMAILS)) notFound();
  return user;
}
