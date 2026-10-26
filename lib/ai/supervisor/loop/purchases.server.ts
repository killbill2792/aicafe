import "server-only";
import {z} from "zod";
import {registerLoopCapability} from "./engine";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {recordPurchases} from "@/lib/inventory/recordPurchases.server";
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const purchaseInputSchema=z.strictObject({
 ingredientId:z.uuid().nullable(),
 name:z.string().trim().min(1).max(160),
 quantity:z.number().finite().positive().max(1e9),
 unit:z.string().trim().min(1).max(40),
 costCents:z.number().int().nonnegative().safe().nullable(),
 date,
 source:z.enum(["receipt_chat","chat_text"])
});
export const purchaseCapabilityId="maya.inventory_purchase.v1";
export const purchaseCapability=registerLoopCapability({
 id:purchaseCapabilityId,version:1,
 inputSchema:purchaseInputSchema,
 effectSchema:purchaseInputSchema,
 proposalDescription:"Draft ONE receipt or typed inventory purchase line for owner approval. Resolve to an existing ingredient by name before recording; never create an unknown item automatically. Approval only via the existing proposal card.",
 dependencyScope:effect=>({kind:"inventory",ingredientId:effect.ingredientId,date:effect.date}),
 simulate:async(scope,input)=>{
  const db=await createServerSupabaseClient();
  const {data:{user}}=await db.auth.getUser();
  if(!user||user.id!==scope.ownerUserId||await getActiveBusinessId(user.id)!==scope.businessId)
   throw new Error("owner_required");
  const {data:member}=await db.from("memberships").select("role,businesses(is_demo)")
   .eq("business_id",scope.businessId).eq("user_id",user.id).maybeSingle();
  const bs=member?.businesses as unknown as {is_demo:boolean}|{is_demo:boolean}[]|null;
  if(member?.role!=="owner"||(Array.isArray(bs)?bs[0]?.is_demo:bs?.is_demo)!==false)
   throw new Error("owner_required");
  const {data:ingredients,error}=await db.from("ingredients").select("id,name,base_unit")
   .eq("business_id",scope.businessId).limit(2000);
  if(error||!ingredients)throw new Error("ingredients_unavailable");
  const norm=(text:string)=>text.trim().toLocaleLowerCase().replace(/\s+/g," ");
  const candidates=ingredients.filter(x=>norm(x.name)===norm(input.name));
  const resolved=input.ingredientId
   ?ingredients.find(x=>x.id===input.ingredientId&&norm(x.name)===norm(input.name))
   :candidates.length===1?candidates[0]:null;
  // Do not auto-create unrecognized or ambiguous item names.
  const effect={...input,ingredientId:resolved?.id??null};
  return {effect,baseline:{subjectName:input.name,matched:Boolean(resolved),quantity:input.quantity,
   enteredUnit:input.unit,costCents:input.costCents},
   monitorSpec:{durationDays:1,metricScope:resolved?.id??"unmatched"}};
 },
 commit:async(_scope,effect,proposalId)=>{
  if(!effect.ingredientId)throw new Error("ingredient_match_required");
  const result=await recordPurchases([{
   lineId:proposalId,ingredientId:effect.ingredientId,date:effect.date,
   quantity:effect.quantity,unit:effect.unit,costCents:effect.costCents
  }],effect.source,proposalId);
  if(result.length!==1||!result[0].ok)throw new Error(result[0]?.error??"purchase_save_failed");
  return {status:"verified",evidenceSource:"pantry_stock_purchases"};
 },
 monitor:async()=>null,
 report:async()=>({status:"complete",result:{},recommendation:"keep",source:"pantry_stock_purchases"})
});
