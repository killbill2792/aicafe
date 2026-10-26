import "server-only";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {modifierLinkKey,suggestModifierLinks,type ObservedModifier,type RecipeCandidate}
 from "@/lib/calc/modifierSuggestions";

export type ModifierSetup=Awaited<ReturnType<typeof readModifierSetup>>;
/** Only owner-visible sales; suggest possible recipe links but never auto-link. */
export async function readModifierSetup(){
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 if(!user)throw new Error("sign_in_required");
 const businessId=await getActiveBusinessId(user.id);
 const member=await db.from("memberships").select("role,businesses(is_demo)")
  .eq("business_id",businessId).eq("user_id",user.id).maybeSingle();
 const raw=member.data?.businesses as unknown as {is_demo:boolean}|{is_demo:boolean}[]|null;
 const demo=Array.isArray(raw)?raw[0]?.is_demo:raw?.is_demo;
 if(member.error||member.data?.role!=="owner"||demo!==false)throw new Error("owner_required");
 const [sales,links,mods,ingredients]=await Promise.all([
  db.from("order_lines").select("id,modifiers,orders!inner(pos_order_id,location_id,business_id)")
   .eq("orders.business_id",businessId).eq("voided",false).order("id",{ascending:false}).limit(2000),
  db.from("pantry_modifier_links").select("provider,location_ref,pos_modifier_id")
   .eq("business_id",businessId).limit(3000),
  db.from("modifier_recipes").select("id,name,ingredient_id,quantity_delta")
   .eq("business_id",businessId).limit(2000),
  db.from("ingredients").select("id,name,base_unit").eq("business_id",businessId).limit(2000)
 ]);
 if(sales.error||links.error||mods.error||ingredients.error||!sales.data||!links.data||!mods.data||!ingredients.data)
  throw new Error("modifier_setup_unavailable");
 const mapped=new Set(links.data.map(row=>modifierLinkKey({
  provider:row.provider as ObservedModifier["provider"],
  locationRef:row.location_ref,posModifierId:row.pos_modifier_id,name:""
 })));
 const byIngredient=new Map(ingredients.data.map(i=>[i.id,i]));
 const recipes:RecipeCandidate[]=mods.data.map(m=>{
  const ing=byIngredient.get(m.ingredient_id??"");
  return {id:m.id,name:m.name,ingredientId:ing?.id??null,
   ingredientName:ing?.name??null,unit:ing?.base_unit as RecipeCandidate["unit"]??null,
   quantityDelta:Number(m.quantity_delta)};
 }).filter(r=>r.ingredientId!==null);
 const seen=new Set<string>(),observed:ObservedModifier[]=[];
 for(const line of sales.data){
  const order=line.orders as unknown as {pos_order_id:string;location_id:string|null};
  const provider:ObservedModifier["provider"]=order.pos_order_id.startsWith("toast:")?"toast":
   order.pos_order_id.startsWith("square:")?"square":"csv";
  const locationRef=provider==="toast"
   ?order.pos_order_id.match(/^toast:([a-f0-9-]{36}):/i)?.[1]??""
   :order.location_id??(provider==="csv"?"csv":"");
  if(!locationRef||!Array.isArray(line.modifiers))continue;
  for(const raw of line.modifiers){
   if(!raw||typeof raw!=="object")continue;
   const row=raw as {posModifierId?:unknown;name?:unknown};
   if(typeof row.posModifierId!=="string"||!row.posModifierId||
      typeof row.name!=="string"||!row.name.trim())continue;
   const item={provider,locationRef,posModifierId:row.posModifierId,name:row.name};
   const key=modifierLinkKey(item);
   if(seen.has(key)||mapped.has(key))continue;
   seen.add(key);observed.push(item);
  }
 }
 const suggestions=suggestModifierLinks(observed,recipes,mapped);
 return {businessId,observed:observed.slice(0,100),ingredients:ingredients.data.map(i=>({id:i.id,name:i.name,baseUnit:i.base_unit})),
  recipes:recipes.slice(0,200),
  suggestions:suggestions.slice(0,100)};
}
