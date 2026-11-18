import {NextResponse} from "next/server";
import {z} from "zod";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireConnectorOwner,getConnectorAccount,connectorOperations} from "@/lib/connectors/registry.server";
import {readBoundedJson,requireSameOrigin} from "@/lib/ai/conversations/http.server";
import {ConversationApiError} from "@/lib/ai/conversations/auth.server";

export const runtime="nodejs";
const noStore={"cache-control":"no-store"};
const requestSchema=z.strictObject({
 accountId:z.uuid(),generation:z.number().int().positive(),
 operations:z.array(z.enum(connectorOperations)).max(connectorOperations.length)
  .refine(list=>new Set(list).size===list.length,"duplicate_operation"),
});
/** Each successful change atomically bumps account and encrypted-credential
 * generations; any previously approved Gmail effect then has a stale account. */
export async function PATCH(request:Request){
 try{requireSameOrigin(request);}
 catch{return NextResponse.json({error:"invalid_origin"},{status:403,headers:noStore});}
 try{
   const owner=await requireConnectorOwner();
   const input=requestSchema.parse(await readBoundedJson(request));
   const account=await getConnectorAccount(owner);
   if(account?.status!=="active"||account.id!==input.accountId||
     account.generation!==input.generation)
     return NextResponse.json({error:"connection_changed_refresh"},{status:409,headers:noStore});
   const {data,error}=await createAdminSupabaseClient().rpc("supervisor_change_gmail_operations",{
     p_business_id:owner.businessId,p_owner_user_id:owner.ownerUserId,
     p_account_id:account.id,p_expected_generation:input.generation,p_operations:input.operations,
   });
   if(error||!data)return NextResponse.json({error:error?.code==="40001"?
     "connection_changed_refresh":"permission_change_unverified"},
     {status:error?.code==="40001"?409:503,headers:noStore});
   const result=data as {generation?:unknown;operations?:unknown};
   if(!Number.isSafeInteger(Number(result.generation))||!Array.isArray(result.operations)||
      result.operations.some(operation=>!connectorOperations.includes(operation))||
      [...result.operations].sort().join(",")!==[...input.operations].sort().join(","))
     return NextResponse.json({error:"permission_change_unverified"},{status:503,headers:noStore});
   return NextResponse.json({status:"active",generation:result.generation,
     enabledOperations:result.operations},{headers:noStore});
 }catch(error){
   if(error instanceof ConversationApiError)
     return NextResponse.json({error:error.code},{status:error.status,headers:noStore});
   return NextResponse.json({error:"permission_change_denied"},{status:403,headers:noStore});
 }
}
