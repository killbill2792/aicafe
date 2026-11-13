import "server-only";
import {createHash} from "node:crypto";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";

export type ConnectorOwner={businessId:string;ownerUserId:string};
export type ConnectorStatus="active"|"needs_reconnect"|"revoking"|"disconnected";
export type ConnectorAccount=ConnectorOwner&{id:string;provider:"gmail";provider_subject:string;
  email:string;granted_scopes:string[];enabled_operations:string[];status:ConnectorStatus;generation:number};
export const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
export async function requireConnectorOwner():Promise<ConnectorOwner>{
  const session=await createServerSupabaseClient();
  const {data:{user},error:userError}=await session.auth.getUser();
  if(userError||!user)throw new Error("connector_unauthorized");
  const businessId=await getActiveBusinessId(user.id);
  const {data:membership,error}=await session.from("memberships").select("role")
    .eq("business_id",businessId).eq("user_id",user.id).maybeSingle();
  if(error||membership?.role!=="owner")throw new Error("connector_owner_required");
  return {businessId,ownerUserId:user.id};
}
export async function getConnectorAccount(scope:ConnectorOwner):Promise<ConnectorAccount|null>{
  const {data,error}=await createAdminSupabaseClient().from("connector_accounts")
    .select("id,business_id,owner_user_id,provider,provider_subject,email,granted_scopes,enabled_operations,status,generation")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("provider","gmail").maybeSingle();
  if(error)throw new Error("connector_status_unavailable");
  if(!data)return null;
  if(data.provider!=="gmail"||data.business_id!==scope.businessId||data.owner_user_id!==scope.ownerUserId)
    throw new Error("connector_scope_mismatch");
  return {id:data.id,businessId:scope.businessId,ownerUserId:scope.ownerUserId,
    provider:"gmail",provider_subject:data.provider_subject,email:data.email,
    granted_scopes:data.granted_scopes,enabled_operations:data.enabled_operations,status:data.status,generation:Number(data.generation)};
}
export const connectorOperations=["read","draft","send","organize"] as const;
export type ConnectorOperation=typeof connectorOperations[number];
// Google gmail.modify is broad; internal operation permission is always checked separately.
export function allowsGmail(account:ConnectorAccount|null,operation:ConnectorOperation):boolean{
  return account?.status==="active"&&account.granted_scopes.includes("https://www.googleapis.com/auth/gmail.modify")&&
    account.enabled_operations.includes(operation) && connectorOperations.includes(operation);
}
export function assertGmailCapability(account:ConnectorAccount|null,operation:ConnectorOperation):asserts account is ConnectorAccount{
  if(!allowsGmail(account,operation))throw new Error("gmail_not_authorized_for_"+operation);
}
