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
  costCents:number|null;expenseLineId?:string|null;
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
 expenseLineId:z.string().uuid().nullable().optional()
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
  const {error:purchaseError}=await db.from("pantry_stock_purchases").upsert({
   business_id:businessId,line_id:line.lineId,ingredient_id:line.ingredientId,
   purchase_date:line.date,entered_quantity:line.quantity,entered_unit:line.unit,
   quantity_base:baseQuantity,cost_cents:line.costCents,
   source,source_ref:sourceRef,expense_line_id:line.expenseLineId??null,
   updated_at:new Date().toISOString()
  },{onConflict:"business_id,line_id"});
  if(purchaseError){
   results.push({lineId,ok:false,error:purchaseError.code==="23505"?"purchase_already_linked":"save_failed"});
   continue;
  }
  if(line.costCents!==null&&line.costCents>0){
   const micros=packToCostPerBaseMicros(line.quantity,line.unit,line.costCents,ingredient.base_unit as BaseUnit)
    ??Math.round(line.costCents*1000000/baseQuantity);
   if(!Number.isSafeInteger(micros)||micros<=0){
    results.push({lineId,ok:false,error:"invalid_cost"});continue;
   }
   const {error:priceError}=await db.from("ingredient_prices").upsert({
    ingredient_id:line.ingredientId,effective_from:line.date,
    cost_per_base_unit_micros:micros,
    source:source==="receipt_page"||source==="receipt_chat"?"receipt":"manual",
    source_expense_line_id:line.expenseLineId??null,source_stock_line_id:line.lineId
   },{onConflict:"source_stock_line_id"});
   if(priceError){results.push({lineId,ok:false,error:"purchase_saved_price_failed"});continue;}
  }
  results.push({lineId,ok:true});
 }
 return results;
}
