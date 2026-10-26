import "server-only";
import {z} from "zod";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";

export type PurchaseMonthLine={
 id:string;lineId:string;ingredientId:string;ingredientName:string;date:string;
 quantity:number;unit:string;baseQuantity:number;baseUnit:string;costCents:number|null;
 source:string;sourceRef:string|null;voided:boolean;
};
const monthSchema=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export async function readPurchaseMonth(rawMonth:string):Promise<{month:string;rows:PurchaseMonthLine[];currency:string}>{
 const month=monthSchema.parse(rawMonth);
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 if(!user)throw new Error("Sign in to view Inventory");
 const businessId=await getActiveBusinessId(user.id);
 const {data:member,error:authError}=await db.from("memberships")
  .select("role,businesses(is_demo,currency)").eq("business_id",businessId).eq("user_id",user.id).maybeSingle();
 const business=member?.businesses as unknown as {is_demo:boolean;currency?:string}|{is_demo:boolean;currency?:string}[]|null;
 const b=Array.isArray(business)?business[0]:business;
 if(authError||member?.role!=="owner"||b?.is_demo!==false)throw new Error("Inventory requires an owner account");
 const [year,part]=month.split("-").map(Number);
 const nextMonth=new Date(Date.UTC(year,part,1)).toISOString().slice(0,7);
 const all:PurchaseMonthLine[]=[];
 for(let offset=0;offset<10000;offset+=500){
  const {data,error}=await db.from("pantry_stock_purchases")
   .select("id,line_id,ingredient_id,purchase_date,entered_quantity,entered_unit,quantity_base,cost_cents,source,source_ref,voided_at,ingredients!inner(name,base_unit)")
   .eq("business_id",businessId).gte("purchase_date",month+"-01").lt("purchase_date",nextMonth+"-01")
   .order("purchase_date",{ascending:false}).order("id").range(offset,offset+499);
  if(error||!data)throw new Error("Inventory history unavailable");
  all.push(...data.map(row=>{
   const ingredient=row.ingredients as unknown as {name:string;base_unit:string}|{name:string;base_unit:string}[];
   const info=Array.isArray(ingredient)?ingredient[0]:ingredient;
   return {id:row.id,lineId:row.line_id,ingredientId:row.ingredient_id,ingredientName:info?.name??"",
    date:row.purchase_date,quantity:Number(row.entered_quantity),unit:row.entered_unit,
    baseQuantity:Number(row.quantity_base),baseUnit:info?.base_unit??"",
    costCents:row.cost_cents,source:row.source,sourceRef:row.source_ref,voided:row.voided_at!==null};
  }));
  if(data.length<500)return {month,rows:all,currency:b?.currency??"USD"};
 }
 throw new Error("Inventory history is too large to display safely");
}
