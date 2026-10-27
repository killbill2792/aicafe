import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";

type ConnectionStatusValue = "active" | "needs_reconnect" | "disconnected";
export type PosConnectionStatus = { provider: string; status: ConnectionStatusValue } | null;

/** docs/03-screens.md "Global states": POS disconnected shows a warn banner with Reconnect. */
export async function getPosConnectionStatus(): Promise<PosConnectionStatus> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const businessId = await getActiveBusinessId(user.id);

  const {data,error}=await supabase.from("pos_connections")
    .select("provider,status").eq("business_id",businessId).limit(10);
  if(error)throw error;
  // A café can connect Toast and Square. The active source takes precedence;
  // failing a single-row query for multiple providers must not hide a warning.
  const priorities:{[k:string]:number}={toast:0,square:1,clover:2,csv:3,demo:4};
  const selected=[...(data??[])].sort((left,right)=>{
    const severity=(status:string)=>status==="active"?0:status==="needs_reconnect"?1:2;
    return severity(left.status)-severity(right.status)||
      (priorities[left.provider]??9)-(priorities[right.provider]??9);
  })[0];
  return selected?{provider:selected.provider,status:selected.status as ConnectionStatusValue}:null;
}
