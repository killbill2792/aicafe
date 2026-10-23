"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {addMenuItem} from "@/lib/actions/menuItems";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
const schema=z.strictObject({name:z.string().trim().min(1).max(80),priceCents:z.number().int().positive(),items:z.array(z.strictObject({
 itemId:z.string().uuid(),quantity:z.number().int().min(1).max(100),buyInCostCents:z.number().int().positive().nullable()
})).min(2).max(20)});
export type ComboRequest=z.infer<typeof schema>;
export async function createMenuCombo(input:ComboRequest):Promise<{ok:true;id:string}|{ok:false;error:string}>{
 const parsed=schema.safeParse(input);if(!parsed.success)return{ok:false,error:"Check combo name, price and items."};
 const ids=parsed.data.items.map(i=>i.itemId);
 if(new Set(ids).size!==ids.length)return{ok:false,error:"Each item can only appear once; increase its quantity instead."};
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 const businessId=user?await getActiveBusinessId(user.id):null;
 if(!businessId)return{ok:false,error:"Sign in first."};
 const {data:items,error:readError,count}=await db.from("menu_items").select("id,price_cents,is_active",{count:"exact"})
 .eq("business_id",businessId).in("id",ids);
 if(readError||!items||count!==ids.length||items.some(i=>!i.is_active||!Number.isSafeInteger(Number(i.price_cents))||Number(i.price_cents)<=0))
 return{ok:false,error:"Select active, priced menu items from your café."};
 const {data:nested,error:nestedError}=await db.from("menu_combo_components").select("combo_item_id").in("combo_item_id",ids).eq("business_id",businessId);
 if(nestedError||nested?.length)return{ok:false,error:"A combo cannot contain another combo."};
 const created=await addMenuItem({name:parsed.data.name,priceCents:parsed.data.priceCents,category:"FOOD",menuGroup:"Combos"});
 if(!created.ok)return created;
 const {error}=await db.from("menu_combo_components").insert(parsed.data.items.map(i=>({
  business_id:businessId,combo_item_id:created.id,component_item_id:i.itemId,quantity:i.quantity,buy_in_cost_cents:i.buyInCostCents
 })));
 if(error){
  // Compensate the newly created menu item; its price history and components cascade.
  const {error:rollbackError}=await db.from("menu_items").delete().eq("business_id",businessId).eq("id",created.id);
  return{ok:false,error:rollbackError?"Combo save failed. A draft may remain; check Menu before retrying.":"Combo not saved; please try again."};
 }
 revalidatePath("/menu");revalidatePath("/menu/new");
 return{ok:true,id:created.id};
}
