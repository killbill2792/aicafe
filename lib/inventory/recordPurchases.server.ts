import "server-only";
import {z} from "zod";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {packBaseQuantity,packToCostPerBaseMicros,type BaseUnit} from "@/lib/calc/recipeUnits";

export const purchaseSources=["manual","bulk","receipt_page","receipt_chat","chat_text","csv","quickbooks","bank_feed"] as const;
export type PurchaseSource=typeof purchaseSources[number];
/** A connector supplies normalized purchase lines; it never bypasses owner review. */
export interface PurchaseSourceAdapter<T> {
  source:PurchaseSource;
  normalize(input:T):Promise<PurchaseLineInput[]>;
}
export type PurchaseLineInput={
  lineId:string;ingredientId:string|null;date:string;quantity:number;unit:string;
  costCents:number|null;expenseLineId?:string|null;expectedUpdatedAt?:string|null;
};
export type PurchaseResult={lineId:string;ok:boolean;error?:string};
const iso=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
 const date=new Date(value+"T12:00:00Z");
 return !Number.isNaN(date.valueOf())&&date.toISOString().slice(0,10)===value;
});
const lineSchema=z.strictObject({
 lineId:z.string().uuid(),ingredientId:z.string().uuid(),date:iso,
 quantity:z.number().finite().positive().max(1e9),unit:z.string().trim().min(1).max(40),
 costCents:z.number().int().nonnegative().safe().nullable(),
 expenseLineId:z.string().uuid().nullable().optional(),
 expectedUpdatedAt:z.string().datetime({offset:true}).nullable().optional()
});

/** The only write path for stock purchases. One rejected line cannot roll back siblings.
 * A caller MUST supply a stable lineId (proposal/CSV row/receipt expense line or UI draft).
 * Idempotent retries upsert the same stock and ingredient-price rows.
 */
export async function recordPurchases(
 items:readonly PurchaseLineInput[],source:PurchaseSource,sourceRef:string|null
):Promise<PurchaseResult[]>{
 if(!purchaseSources.includes(source)||items.length>500||sourceRef!==null&&sourceRef.length>200)
  return items.map(line=>({lineId:String(line.lineId),ok:false,error:"invalid_request"}));
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 if(!user)return items.map(line=>({lineId:String(line.lineId),ok:false,error:"sign_in_required"}));
 const businessId=await getActiveBusinessId(user.id);
 const {data:member,error:memberError}=await db.from("memberships")
  .select("role,businesses(is_demo)").eq("business_id",businessId).eq("user_id",user.id).maybeSingle();
 const business=member?.businesses as unknown as {is_demo:boolean}|{is_demo:boolean}[]|null;
 const isDemo=Array.isArray(business)?business[0]?.is_demo:business?.is_demo;
 if(memberError||member?.role!=="owner"||isDemo!==false)
  return items.map(line=>({lineId:String(line.lineId),ok:false,error:"owner_required"}));
 const seen=new Set<string>();
 const results:PurchaseResult[]=[];
 for(const raw of items){
  const lineId=String(raw.lineId);
  const parsed=lineSchema.safeParse(raw);
  if(!parsed.success){results.push({lineId,ok:false,error:"invalid_purchase_line"});continue;}
  const line=parsed.data;
  if(seen.has(lineId)){results.push({lineId,ok:false,error:"repeated_line_id"});continue;}
  seen.add(lineId);
  const {data:ingredient,error:ingredientError}=await db.from("ingredients").select("id,base_unit")
   .eq("business_id",businessId).eq("id",line.ingredientId).maybeSingle();
  if(ingredientError||!ingredient){results.push({lineId,ok:false,error:"ingredient_not_found"});continue;}
  const {data:conversionRows,error:conversionError}=await db.from("ingredient_unit_conversions")
   .select("unit,base_units_per_unit").eq("ingredient_id",line.ingredientId);
  if(conversionError){results.push({lineId,ok:false,error:"conversion_unavailable"});continue;}
  const conversion=(conversionRows??[]).find(row=>row.unit===line.unit);
  const rawBase=conversion?line.quantity*Number(conversion.base_units_per_unit):
   packBaseQuantity(line.quantity,line.unit,ingredient.base_unit as BaseUnit);
  const baseQuantity=rawBase===null?null:Math.round(rawBase*10000)/10000;
  if(baseQuantity===null||!Number.isFinite(baseQuantity)||baseQuantity<=0||baseQuantity>1e9){
   results.push({lineId,ok:false,error:"invalid_unit"});continue;
  }
  if(line.expenseLineId){
   if(!["receipt_page","receipt_chat"].includes(source)){
    results.push({lineId,ok:false,error:"invalid_expense_link"});continue;
   }
   const {data:expenseLine,error:expenseError}=await db.from("expense_lines")
    .select("id,expenses!inner(business_id)").eq("id",line.expenseLineId)
    .eq("expenses.business_id",businessId).maybeSingle();
   if(expenseError||!expenseLine){results.push({lineId,ok:false,error:"invalid_expense_link"});continue;}
  }
  // Validate the derived price before any mutation; the DB RPC saves stock
  // and price within one PostgreSQL transaction or rolls both back.
  const micros=line.costCents!==null&&line.costCents>0
   ?packToCostPerBaseMicros(line.quantity,line.unit,line.costCents,ingredient.base_unit as BaseUnit)
     ??Math.round(line.costCents*1000000/baseQuantity):null;
  if(micros!==null&&(!Number.isSafeInteger(micros)||micros<=0)){
   results.push({lineId,ok:false,error:"invalid_cost"});continue;
  }
  const {error:purchaseError}=await db.rpc("pantry_write_purchase_line",{
   p_business_id:businessId,p_line_id:line.lineId,p_ingredient_id:line.ingredientId,
   p_date:line.date,p_quantity:line.quantity,p_unit:line.unit,p_base_quantity:baseQuantity,
   p_cost_cents:line.costCents,p_price_micros:micros,p_source:source,
   p_source_ref:sourceRef,p_expense_line_id:line.expenseLineId??null,
   p_expected_updated_at:line.expectedUpdatedAt??null
  });
  if(purchaseError){
   results.push({lineId,ok:false,error:purchaseError.code==="40001"?"purchase_changed":
    purchaseError.code==="23505"?"purchase_already_linked":
    purchaseError.code==="42501"?"owner_required":"save_failed"});
   continue;
  }
  results.push({lineId,ok:true});
 }
 return results;
}
