import {authenticatedConversationContext,ConversationApiError} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin}
 from "@/lib/ai/conversations/http.server";
import {quoteInput} from "@/lib/ai/suppliers/contracts";
import {createServerSupabaseClient} from "@/lib/supabase/server";
export const runtime="nodejs";export const dynamic="force-dynamic";
const cols="id,supplier_name,item_name,price_cents,package_count,package_unit,source_kind,source_url,quoted_on,evidence_status,created_at";
type Row={id:string;supplier_name:string;item_name:string;price_cents:number;package_count:number;
 package_unit:string;source_kind:string;source_url:string|null;quoted_on:string;evidence_status:"owner_reported";created_at:string};
const present=(r:Row)=>({id:r.id,supplierName:r.supplier_name,itemName:r.item_name,
 priceCents:r.price_cents,packageCount:r.package_count,packageUnit:r.package_unit,
 sourceKind:r.source_kind,sourceUrl:r.source_url,quotedOn:r.quoted_on,
 evidenceStatus:r.evidence_status,createdAt:r.created_at});
export async function GET(){
 try{
  const {scope}=await authenticatedConversationContext();
  const db=await createServerSupabaseClient();
  const {data,error}=await db.from("ai_supplier_quotes").select(cols)
   .eq("business_id",scope.businessId).order("created_at",{ascending:false}).limit(40);
  if(error)throw error;
  return conversationJson({items:(data as Row[]).map(present)});
 }catch(error){return conversationError(error);}
}
export async function POST(request:Request){
 try{
  requireSameOrigin(request);
  const x=parseInput(quoteInput,await readBoundedJson(request));
  if(x.quotedOn>new Date().toISOString().slice(0,10))
   throw new ConversationApiError(422,"future_quote_date");
  const {scope}=await authenticatedConversationContext();
  const db=await createServerSupabaseClient();
  const payload={
   business_id:scope.businessId,owner_user_id:scope.ownerUserId,
   client_request_id:x.requestId,supplier_name:x.supplierName,item_name:x.itemName,
   price_cents:x.priceCents,package_count:x.packageCount,package_unit:x.packageUnit,
   source_kind:x.sourceKind,source_url:x.sourceUrl,quoted_on:x.quotedOn,
  };
  const {data,error}=await db.from("ai_supplier_quotes").insert(payload).select(cols).single();
  if(error?.code==="23505"){
   const previous=await db.from("ai_supplier_quotes").select(cols)
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("client_request_id",x.requestId).maybeSingle();
   if(previous.error)throw previous.error;
   if(!previous.data)throw error;
   const original=previous.data as Row;
   if(original.supplier_name!==x.supplierName||original.item_name!==x.itemName||
      original.price_cents!==x.priceCents||original.package_count!==x.packageCount||
      original.package_unit!==x.packageUnit||original.source_kind!==x.sourceKind||
      original.source_url!==x.sourceUrl||original.quoted_on!==x.quotedOn)
    return conversationJson({error:"idempotency_conflict"},409);
   return conversationJson({quote:present(original)},200);
  }
  if(error)throw error;
  return conversationJson({quote:present(data as Row)},201);
 }catch(error){return conversationError(error);}
}
