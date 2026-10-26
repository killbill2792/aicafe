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
