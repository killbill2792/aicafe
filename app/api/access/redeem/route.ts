import {z} from "zod";
import {requireSameOrigin,readBoundedJson,conversationJson,conversationError} from "@/lib/ai/conversations/http.server";
import {requireOwnerAccessScope,accessCodeHash} from "@/lib/access/access.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){
 try{
  requireSameOrigin(request);
  const input=z.strictObject({code:z.string().min(1).max(64)}).safeParse(await readBoundedJson(request));
  if(!input.success)return conversationJson({error:"invalid_code"},422);
  const owner=await requireOwnerAccessScope();
  const hash=accessCodeHash(input.data.code);
  const {data,error}=await createAdminSupabaseClient().rpc("redeem_free_access_code",{
   p_business_id:owner.businessId,p_code_hash:hash,p_owner_id:owner.userId,
  });
  if(error)throw error;
  const result=data as {status:string;access_end?:string};
  return conversationJson(result,result.status==="rate_limited"?429:result.status==="ok"?200:422);
 }catch(error){return conversationError(error);}
}
