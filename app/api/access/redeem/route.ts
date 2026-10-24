import {z} from "zod";
import {requireSameOrigin,readBoundedJson,conversationJson,conversationError} from "@/lib/ai/conversations/http.server";
import {requireOwnerAccessScope,redeemCafeFreeCode} from "@/lib/access/access.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){
 try{
  requireSameOrigin(request);
  const input=z.strictObject({code:z.string().min(1).max(64)}).safeParse(await readBoundedJson(request));
  if(!input.success)return conversationJson({error:"invalid_code"},422);
  const owner=await requireOwnerAccessScope();
  const result=await redeemCafeFreeCode(owner.businessId,owner.userId,input.data.code);
  return conversationJson(result,result.status==="rate_limited"?429:result.status==="ok"?200:422);
 }catch(error){return conversationError(error);}
}
