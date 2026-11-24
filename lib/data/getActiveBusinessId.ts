import "server-only";
import {cache} from "react";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const ACTIVE_BUSINESS_COOKIE = "active_business_id";

/** Only authenticated non-demo membership may select an active business.
 * A missing real café is an onboarding requirement, never shared demo access. */
export async function getActiveBusinessId(userId:string):Promise<string>{
  return getActiveBusinessIdCached(userId);
}
/** One authenticated membership read per server render, shared with the onboarding guard.
 * React cache() is request-scoped: never share member rows across users or requests. */
export const readActiveBusinessMemberships=cache(async function readActiveBusinessMemberships(userId:string){
  const supabase = await createServerSupabaseClient();
  const { data: memberships } = await supabase
    .from("memberships")
    .select("business_id, role, businesses(is_demo, name, timezone, currency, opened_on)")
    .eq("user_id", userId);
  return memberships ?? [];
});
const getActiveBusinessIdCached=cache(async function getActiveBusinessIdCached(userId:string):Promise<string>{
  const rows=await readActiveBusinessMemberships(userId);
  const real=rows.filter(row=>{
    const b=row.businesses as unknown as {is_demo:boolean}|{is_demo:boolean}[]|null;
    return (Array.isArray(b)?b[0]?.is_demo:b?.is_demo)===false;
  });
  if(real.length===0)throw new Error("own_business_required");
  const cookieStore=await cookies();
  const requested=cookieStore.get(ACTIVE_BUSINESS_COOKIE)?.value;
  if(requested&&real.some(row=>row.business_id===requested))return requested;
  return real[0].business_id;
});
