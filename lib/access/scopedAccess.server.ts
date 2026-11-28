import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConnectorOwner } from "@/lib/connectors/registry.server";
import { accessStatus } from "@/lib/access/status";

export type AccessReader = Pick<SupabaseClient, "from">;

export async function readCafeAccess(client:AccessReader,businessId:string){
  const [{data,error},{data:business,error:tzError}]=await Promise.all([
    client.from("cafe_access").select("mode,access_end").eq("business_id",businessId).maybeSingle(),
    client.from("businesses").select("timezone").eq("id",businessId).maybeSingle(),
  ]);
  if(tzError)throw tzError;
  if(error&&!["42P01","PGRST205"].includes(error.code??""))throw error;
  return accessStatus(data,new Date(),business?.timezone||"UTC");
}

export async function requireConnectorMembership(client:AccessReader,scope:ConnectorOwner){
  const {data,error}=await client.from("memberships").select("role").eq("business_id",scope.businessId)
    .eq("user_id",scope.ownerUserId).maybeSingle();
  if(error||data?.role!=="owner")throw Error("connector_owner_access_revoked");
}

export async function readExternalAccess(client:AccessReader,scope:ConnectorOwner,kind:string,resourceKey:string){
  const {data,error}=await client.from("supervisor_external_access").select("allowed,revision")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).eq("kind",kind)
    .eq("resource_key",kind==="attachment"?resourceKey.toLowerCase():resourceKey).maybeSingle();
  if(error)throw Error("external_access_unavailable");
  if(!data)return {allowed:true,revision:0};
  const revision=Number(data.revision);
  if(typeof data.allowed!=="boolean"||!Number.isSafeInteger(revision))throw Error("external_access_invalid");
  return {allowed:data.allowed,revision};
}
