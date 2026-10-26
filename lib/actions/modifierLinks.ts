"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {readModifierSetup} from "@/lib/data/modifierLinks.server";
import {modifierLinkKey} from "@/lib/calc/modifierSuggestions";

const inputSchema=z.strictObject({
 provider:z.enum(["toast","square","csv"]),
 locationRef:z.string().min(1).max(120),posModifierId:z.string().min(1).max(200),
 recipeId:z.uuid()
});
/** Confirmed by an explicit owner click. No auto-match or model-driven write. */
export async function confirmModifierLink(raw:unknown):Promise<{ok:boolean;error?:string}>{
 const parsed=inputSchema.safeParse(raw);
 if(!parsed.success)return {ok:false,error:"invalid_link"};
 try{
  const setup=await readModifierSetup(); // ensures active owner, non-demo, verified candidates
  const input=parsed.data;
  const key=modifierLinkKey({...input,name:""});
  if(!setup.observed.some(row=>modifierLinkKey(row)===key)||
    !setup.recipes.some(row=>row.id===input.recipeId))
   return {ok:false,error:"link_no_longer_available"};
  const db=await createServerSupabaseClient();
  const {data:{user}}=await db.auth.getUser();
  if(!user)return {ok:false,error:"owner_required"};
  const businessId=await getActiveBusinessId(user.id);
  // An observed, unmapped modifier can only get its first mapping here.
  const {error}=await db.from("pantry_modifier_links").insert({
   business_id:businessId,provider:input.provider,location_ref:input.locationRef,
   pos_modifier_id:input.posModifierId,modifier_recipe_id:input.recipeId
  });
  if(error)return {ok:false,error:error.code==="23505"?"link_already_confirmed":"save_failed"};
  revalidatePath("/menu/pantry");return {ok:true};
 }catch{return {ok:false,error:"owner_required_or_unavailable"};}
}

const newRecipeSchema=z.strictObject({
 provider:z.enum(["toast","square","csv"]),
 locationRef:z.string().min(1).max(120),posModifierId:z.string().min(1).max(200),
 name:z.string().trim().min(1).max(160),
 ingredientId:z.uuid(),quantityDelta:z.number().finite().positive().max(999999),
 replacesIngredientId:z.uuid().nullable()
});
export async function createAndConfirmModifierLink(raw:unknown):Promise<{ok:boolean;error?:string}>{
 const parsed=newRecipeSchema.safeParse(raw);
 if(!parsed.success)return {ok:false,error:"invalid_recipe"};
 try{
  const input=parsed.data;
  const setup=await readModifierSetup();
  const key=modifierLinkKey({...input,name:""});
  const observed=setup.observed.find(row=>modifierLinkKey(row)===key);
  if(!observed||observed.name!==input.name||
    !setup.ingredients.some(i=>i.id===input.ingredientId)||
    input.replacesIngredientId&&!setup.ingredients.some(i=>i.id===input.replacesIngredientId))
    return {ok:false,error:"modifier_changed"};
  const db=await createServerSupabaseClient();
  const {data:{user}}=await db.auth.getUser();
  if(!user)return {ok:false,error:"owner_required"};
  const businessId=await getActiveBusinessId(user.id);
  const {error}=await db.rpc("pantry_create_modifier_recipe_link",{
   p_business_id:businessId,p_provider:input.provider,p_location_ref:input.locationRef,
   p_pos_modifier_id:input.posModifierId,p_name:input.name,
   p_ingredient_id:input.ingredientId,p_quantity_delta:input.quantityDelta,
   p_replaces_ingredient_id:input.replacesIngredientId
  });
  if(error)return {ok:false,error:error.code==="40001"||error.code==="23505"?"link_already_confirmed":"save_failed"};
  revalidatePath("/menu/pantry");return {ok:true};
 }catch{return {ok:false,error:"owner_required_or_unavailable"};}
}
