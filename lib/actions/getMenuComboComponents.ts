"use server";
import {z} from "zod";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
export type SavedComboPart={componentItemId:string;quantity:number;buyInCostCents:number|null};
export async function getMenuComboComponents(comboItemId:string):Promise<SavedComboPart[]>{
 if(!z.string().uuid().safeParse(comboItemId).success)return[];
 const db=await createServerSupabaseClient(),{data:{user}}=await db.auth.getUser();
 const businessId=user?await getActiveBusinessId(user.id):null;if(!businessId)return[];
 const {data,error}=await db.from("menu_combo_components")
 .select("component_item_id,quantity,buy_in_cost_cents").eq("business_id",businessId).eq("combo_item_id",comboItemId);
 if(error?.code==="42P01")return[];
 if(error||!data)throw new Error("Could not load combo components.");
 return data.map(part=>({componentItemId:part.component_item_id,quantity:part.quantity,buyInCostCents:part.buy_in_cost_cents===null?null:Number(part.buy_in_cost_cents)}));
}
