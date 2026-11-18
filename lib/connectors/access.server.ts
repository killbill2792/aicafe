import "server-only";
import {z} from "zod";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {assertConnectorOwnerLive,type ConnectorOwner} from "./registry.server";

// An absent override preserves the existing read-only web search and selected-file
// behavior. A failed database read never silently becomes permission to proceed.
export const externalKind=z.enum(["public_web","file_read","attachment"]);
export type ExternalKind=z.infer<typeof externalKind>;
export type ExternalAccess={allowed:boolean;revision:number};
export const WEB_RESOURCE="public";
export const FILE_RESOURCE="all";
export async function externalAccess(scope:ConnectorOwner,kind:ExternalKind,resourceKey:string):
 Promise<ExternalAccess>{
 const {data,error}=await createAdminSupabaseClient().from("supervisor_external_access")
   .select("allowed,revision").eq("business_id",scope.businessId)
   .eq("owner_user_id",scope.ownerUserId).eq("kind",kind)
   .eq("resource_key",kind==="attachment"?resourceKey.toLowerCase():resourceKey).maybeSingle();
 if(error)throw new Error("external_access_unavailable");
 if(!data)return {allowed:true,revision:0};
 if(typeof data.allowed!=="boolean"||!Number.isSafeInteger(Number(data.revision)))
   throw new Error("external_access_invalid");
 return {allowed:data.allowed,revision:Number(data.revision)};
}
export async function assertExternalAccess(scope:ConnectorOwner,kind:ExternalKind,resourceKey:string){
 await assertConnectorOwnerLive(scope);
 const state=await externalAccess(scope,kind,resourceKey);
 if(!state.allowed)throw new Error(kind+"_access_revoked");
 return state.revision;
}
export async function assertSelectedAttachmentAccess(scope:ConnectorOwner,attachmentId:string){
 z.uuid().parse(attachmentId);
 // General file revocation AND the precise file's irreversible revocation
 // must both authorize the owner-selected attachment.
 await assertExternalAccess(scope,"file_read",FILE_RESOURCE);
 await assertExternalAccess(scope,"attachment",attachmentId);
}
export async function changeExternalAccess(scope:ConnectorOwner,kind:ExternalKind,
 resourceKey:string,allowed:boolean,expectedRevision:number):Promise<ExternalAccess>{
 if(kind==="public_web"&&resourceKey!==WEB_RESOURCE||
    kind==="file_read"&&resourceKey!==FILE_RESOURCE||
    kind==="attachment"&&(!z.uuid().safeParse(resourceKey).success||allowed)||
    !Number.isSafeInteger(expectedRevision)||expectedRevision<0)
   throw new Error("external_access_input_invalid");
 const {data,error}=await createAdminSupabaseClient().rpc("supervisor_change_external_access",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
   p_kind:kind,p_resource_key:kind==="attachment"?resourceKey.toLowerCase():resourceKey,
   p_allowed:allowed,p_expected_revision:expectedRevision,
 });
 if(error||!data)throw new Error(error?.code==="40001"||error?.code==="23505"?
   "external_access_stale":"external_access_change_failed");
 const result=data as {allowed?:unknown;revision?:unknown};
 if(result.allowed!==allowed||!Number.isSafeInteger(Number(result.revision)))
   throw new Error("external_access_change_unverified");
 return {allowed,revision:Number(result.revision)};
}
