import "server-only";
import {AsyncLocalStorage} from "node:async_hooks";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import {assertExternalAccess,WEB_RESOURCE} from "./access.server";
import type {ConnectorOwner} from "./registry.server";
import type {WebSearchResult} from "@/lib/ai/agent/webSearch.server";

// The existing café+owner permission is the sole authority. A request-scoped
// binding keeps parallel city/holiday queries and their retries in the same
// authenticated owner scope; never infer authority from a city, query or cache.
const scopeContext=new AsyncLocalStorage<ConnectorOwner>();
export class PublicWebPermissionError extends Error{
  constructor(readonly reason:"permissionDenied"|"permissionsUnavailable"){
    super(reason);this.name="PublicWebPermissionError";
  }
}
async function assertOwnerPublicWeb(scope:ConnectorOwner):Promise<void>{
  try{
    await assertCafeAiAccess(scope.businessId);
    await assertExternalAccess(scope,"public_web",WEB_RESOURCE);
  }catch(error){
    throw new PublicWebPermissionError(error instanceof Error&&
      error.message==="public_web_access_revoked"?"permissionDenied":"permissionsUnavailable");
  }
}
export async function ownerPublicWebAllowed(scope:ConnectorOwner):Promise<boolean>{
  try{await assertOwnerPublicWeb(scope);return true;}catch{return false;}
}
export function withOwnerPublicWebScope<T>(scope:ConnectorOwner,work:()=>T):T{
  return scopeContext.run({businessId:scope.businessId,ownerUserId:scope.ownerUserId},work);
}
export async function ownerPublicWebSearch(scope:ConnectorOwner,
  search:()=>Promise<WebSearchResult>):Promise<WebSearchResult>{
  try{
    await assertOwnerPublicWeb(scope);
    return await withOwnerPublicWebScope(scope,search);
  }catch(error){
    if(error instanceof PublicWebPermissionError)return {available:false,reason:error.reason};
    throw error;
  }
}
// Every production hosted-web request (including recursive searches, fallback
// models and retry attempts) goes through this boundary immediately before fetch.
// Unscoped work and unavailable permission reads fail closed. Already-dispatched
// network work cannot be recalled; no subsequent request can start on stale access.
export const ownerPublicWebFetch:typeof fetch=async(input,init)=>{
  const scope=scopeContext.getStore();
  if(!scope)throw new PublicWebPermissionError("permissionsUnavailable");
  await assertOwnerPublicWeb(scope);
  return fetch(input,init);
};
