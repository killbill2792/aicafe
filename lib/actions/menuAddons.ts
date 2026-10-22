"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import {prepareIngredientSwap} from "@/lib/data/pantry.server";
const id=z.string().uuid();
const option=z.strictObject({
 ingredientId:id,kind:z.enum(["milk","extra"]),enabled:z.boolean(),
 isDefault:z.boolean(),upchargeCents:z.number().int().nonnegative(),
 displayUnit:z.enum(["g","ml","fl_oz","each","shot","pump"]),
 displayQuantity:z.number().finite().positive().max(100000)
});
export type MenuAddon=z.infer<typeof option>;
async function scope(){
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 const businessId=user?await getActiveBusinessId(user.id):null;
 return businessId?{db,businessId}:null;
}
export async function getMenuProductAddons(productIds:string[]):Promise<MenuAddon[]>{
 const parsed=z.array(id).min(1).max(30).safeParse(productIds);
 if(!parsed.success)return [];
 const ctx=await scope();if(!ctx)return [];
 const {data,error}=await ctx.db.from("menu_product_addons")
 .select("ingredient_id,kind,enabled,is_default,upcharge_cents,display_unit,display_quantity")
 .eq("business_id",ctx.businessId).in("menu_item_id",parsed.data);
 if(error?.code==="42P01"||error?.code==="PGRST205")return []; // Preview may run before additive migration; do not break menu detail.
 if(error||!data)throw new Error("Could not load add-ons.");
 return data.map(row=>({ingredientId:row.ingredient_id,kind:row.kind as MenuAddon["kind"],enabled:row.enabled,
 isDefault:row.is_default,upchargeCents:Number(row.upcharge_cents),
 displayUnit:row.display_unit as MenuAddon["displayUnit"],displayQuantity:Number(row.display_quantity)}));
}
export async function saveMenuProductAddons(itemId:string,options:MenuAddon[],milkSwap?:{fromId:string;toId:string}|null):Promise<{ok:true}|{ok:false;error:string}>{
 const parsed=z.object({itemId:id,options:z.array(option).max(60)}).safeParse({itemId,options});
 if(!parsed.success)return {ok:false,error:"Invalid add-ons."};
 const ctx=await scope();if(!ctx)return{ok:false,error:"Sign in first."};
 const distinct=new Set(parsed.data.options.map(o=>o.kind+":"+o.ingredientId));
 if(distinct.size!==parsed.data.options.length||parsed.data.options.filter(o=>o.kind==="milk"&&o.isDefault).length>1||
 parsed.data.options.some(o=>o.kind==="extra"&&o.isDefault))return{ok:false,error:"Choose one default milk."};
 const swapSchema=z.strictObject({fromId:id,toId:id});
 const checkedSwap=milkSwap?swapSchema.safeParse(milkSwap):null;
 if(checkedSwap&&!checkedSwap.success)return {ok:false,error:"Invalid milk choice."};
 if(checkedSwap?.success && !parsed.data.options.some(o=>o.kind==="milk"&&o.isDefault&&o.enabled&&o.ingredientId===checkedSwap.data.toId))
  return {ok:false,error:"The selected default milk does not match the recipe change."};
 const prepared=checkedSwap?.success?
  await prepareIngredientSwap(parsed.data.itemId,checkedSwap.data.fromId,checkedSwap.data.toId):null;
 if(prepared&&!prepared.ok)return {ok:false,error:prepared.error};
 const {error}=await ctx.db.rpc("save_menu_product_addons",{
  p_business_id:ctx.businessId,p_item_id:parsed.data.itemId,
  p_options: {options:parsed.data.options,...(prepared?.ok&&prepared.changes.length?{recipeChanges:prepared.changes}:{})},
 });
 if(error)return{ok:false,error:"Could not save add-ons."};
 revalidatePath("/menu");revalidatePath(`/menu/${itemId}`);
 return{ok:true};
}
