import "server-only";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { packBaseQuantity, toBaseUnitQuantity, type BaseUnit, type RecipeDisplayUnit } from "@/lib/calc/recipeUnits";
import { calculateUsage, type UsageIngredient, type UsageRecipe, type UsageModifier, type UsageSale, type UsageCount, type UsagePurchase, type UsageStaff, type UsageRow } from "@/lib/calc/usageVariance";

const iso=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!Number.isNaN(Date.parse(s+"T00:00:00Z")));
const readInput=z.strictObject({
 from:iso,to:iso,ingredient:z.string().max(100).nullable().optional(),
 groupBy:z.enum(["day","shift","staff"]).nullable().optional()
}).refine(v=>v.to>=v.from&& (Date.parse(v.to)-Date.parse(v.from))/86400000<=30);
const stockInput=z.strictObject({
 ingredientId:z.string().uuid(),date:iso,quantity:z.number().finite().nonnegative().max(1000000000),
 unit:z.string().min(1).max(40)
});
async function scope(){
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 if(!user)throw new Error("sign_in_required");
 const businessId=await getActiveBusinessId(user.id);
 const {data:membership,error}=await db.from("memberships").select("role")
  .eq("user_id",user.id).eq("business_id",businessId).maybeSingle();
 if(error||membership?.role!=="owner")throw new Error("owner_required");
 return {db,businessId};
}
const dateAfter=(day:string)=>new Date(Date.parse(day+"T12:00:00Z")+86400000).toISOString().slice(0,10);
async function allRows<T>(load:(first:number,last:number)=>PromiseLike<{data:T[]|null;error:unknown}>,max=20000):Promise<T[]>{
 const all:T[]=[];
 for(let offset=0;offset<=max;offset+=500){
  const {data,error}=await load(offset,offset+499);
  if(error||!data)throw new Error("usage_data_unavailable");
  all.push(...data);
  if(data.length<500)return all;
 }
 throw new Error("usage_rows_exceed_safe_limit");
}
/** UI and Maya use this same owner-scoped read; no LLM/client-supplied business ID. */
export async function readUsageVariance(raw:z.input<typeof readInput>):Promise<{from:string;to:string;rows:UsageRow[];missing:string[];groupBy:string|null}>{
 const input=readInput.parse(raw);
 const {db,businessId}=await scope();
 const {data:ingredients,error:ie}=await db.from("ingredients").select("id,name,base_unit")
  .eq("business_id",businessId).order("name").limit(1000);
 if(ie||!ingredients)throw new Error("usage_ingredients_unavailable");
 const selected=ingredients.filter(i=>!input.ingredient||
  i.id===input.ingredient||i.name.toLowerCase().includes(input.ingredient.toLowerCase()));
 const allIds=ingredients.map(i=>i.id),chosenIds=selected.map(i=>i.id);
 const [evidence,recipes,modifiers,addons,conversions,counts,purchases,sales] = await Promise.all([
  db.rpc("pantry_usage_toast_evidence",{p_business_id:businessId,p_from:input.from,p_to:input.to}),
  allRows((a,b)=>db.from("recipe_lines").select("menu_item_id,ingredient_id,quantity,menu_items!inner(business_id)")
   .eq("menu_items.business_id",businessId).order("menu_item_id").order("ingredient_id").range(a,b),8000),
  db.from("modifier_recipes").select("id,pos_modifier_id,name,ingredient_id,quantity_delta,replaces_ingredient_id").eq("business_id",businessId).limit(2000),
  db.from("menu_product_addons").select("menu_item_id,ingredient_id,kind,is_default,enabled,display_unit,display_quantity")
   .eq("business_id",businessId).limit(3000),
  allIds.length?db.from("ingredient_unit_conversions").select("ingredient_id,unit,base_units_per_unit").in("ingredient_id",allIds).limit(3000):Promise.resolve({data:[],error:null}),
  chosenIds.length?db.from("pantry_stock_counts").select("ingredient_id,count_date,quantity_base")
   .eq("business_id",businessId).in("ingredient_id",chosenIds).in("count_date",[input.to,new Date(Date.parse(input.from+"T12:00:00Z")-86400000).toISOString().slice(0,10)]):Promise.resolve({data:[],error:null}),
  chosenIds.length?allRows((a,b)=>db.from("pantry_stock_purchases").select("ingredient_id,purchase_date,quantity_base")
    .eq("business_id",businessId).in("ingredient_id",chosenIds).gte("purchase_date",input.from).lte("purchase_date",input.to)
    .order("id").range(a,b),8000):Promise.resolve([]),
  allRows((a,b)=>db.from("order_lines").select("id,menu_item_id,quantity,modifiers,voided,orders!inner(business_id,business_date,closed_at,pos_order_id)")
    .eq("orders.business_id",businessId).gte("orders.business_date",input.from).lte("orders.business_date",input.to)
    .like("orders.pos_order_id","toast:%").order("id").range(a,b),20000),
 ]);
 if(evidence.error||modifiers.error||addons.error||conversions.error||counts.error||!modifiers.data||!addons.data||!conversions.data||!counts.data)
  throw new Error("usage_data_unavailable");
 const e=evidence.data as {covered?:boolean;staff?:UsageStaff[];modifierMappings?:Array<{posModifierId:string;recipeId:string}>}|null;
 const mappedMods=new Map<string,UsageModifier>();
 const recipeMods=new Map(modifiers.data.map(m=>[m.id,m]));
 const matchRecipe=(recipe:typeof modifiers.data[number],key:string)=>{
  mappedMods.set(key,{posModifierId:key,ingredientId:recipe.ingredient_id,quantityDelta:Number(recipe.quantity_delta),
   replacesIngredientId:recipe.replaces_ingredient_id});
 };
 for(const m of modifiers.data)if(m.pos_modifier_id){
  matchRecipe(m,m.pos_modifier_id);
  if(m.pos_modifier_id.startsWith("toast:"))matchRecipe(m,m.pos_modifier_id.split(":").at(-1)!);
 }
 for(const mapping of e?.modifierMappings??[]){
  const record=recipeMods.get(mapping.recipeId);
  if(record)matchRecipe(record,mapping.posModifierId);
 }
 const ingredientById=new Map(ingredients.map(i=>[i.id,i]));
 const conversionByIngredient=new Map<string,Array<{unit:"shot"|"pump";baseUnitsPerUnit:number}>>();
 for(const c of conversions.data){
  const list=conversionByIngredient.get(c.ingredient_id)??[];
  if(c.unit==="shot"||c.unit==="pump")list.push({unit:c.unit,baseUnitsPerUnit:Number(c.base_units_per_unit)});
  conversionByIngredient.set(c.ingredient_id,list);
 }
 const addonsByItem=new Map<string,typeof addons.data>();
 for(const a of addons.data){const list=addonsByItem.get(a.menu_item_id)??[];list.push(a);addonsByItem.set(a.menu_item_id,list);}
 // Every recorded option must resolve through a stable Toast modifier id or an
 // unambiguous product-level ingredient match. Anything else remains unknown.
 const salesRows:UsageSale[]=sales.filter(s=>!s.voided).map(s=>{
  const order=s.orders as unknown as {closed_at:string;business_date:string};
  const savedMods=Array.isArray(s.modifiers)?s.modifiers as Array<{posModifierId?:string;name?:string}>:[];
  const optionRows=addonsByItem.get(s.menu_item_id??"")??[];
  const normalized=savedMods.map((m,index)=>{
   const key=String(m.posModifierId??"");
   if(mappedMods.has(key))return {posModifierId:key,name:m.name??""};
   const matches=optionRows.filter(a=>a.enabled&&
    ingredientById.get(a.ingredient_id)?.name.toLowerCase()===String(m.name??"").trim().toLowerCase());
   if(matches.length===1){
    const match=matches[0],ingredient=ingredientById.get(match.ingredient_id)!;
    const qty=toBaseUnitQuantity(match.display_unit as RecipeDisplayUnit,Number(match.display_quantity),
      ingredient.base_unit as BaseUnit,conversionByIngredient.get(match.ingredient_id)??[]);
    const defaultMilk=optionRows.find(a=>a.kind==="milk"&&a.is_default);
    if(qty!==null&&(match.kind!=="milk"||defaultMilk)){
     const synthetic="addon:"+s.id+":"+index;
     mappedMods.set(synthetic,{posModifierId:synthetic,ingredientId:match.ingredient_id,
      quantityDelta:qty,replacesIngredientId:match.kind==="milk"?defaultMilk!.ingredient_id:null});
     return {posModifierId:synthetic,name:m.name??""};
    }
   }
   // Do not accidentally match Toast modifiers with generic names across items.
   return {posModifierId:key||"unmapped:"+s.id+":"+index,name:m.name??""};
  });
  return {menuItemId:s.menu_item_id,quantity:Number(s.quantity),businessDate:order.business_date,
   closedAt:order.closed_at,modifiers:normalized};
 });
 const rows=calculateUsage({ingredients:selected.map(i=>({id:i.id,name:i.name,unit:i.base_unit as UsageIngredient["unit"]})),
  recipes:recipes.map(r=>({menuItemId:r.menu_item_id,ingredientId:r.ingredient_id,quantity:Number(r.quantity)} satisfies UsageRecipe)),
  modifiers:[...mappedMods.values()],sales:salesRows,salesCovered:e?.covered===true,
  counts:counts.data.map(c=>({ingredientId:c.ingredient_id,date:c.count_date,quantity:Number(c.quantity_base)} satisfies UsageCount)),
  purchases:purchases.map(p=>({ingredientId:p.ingredient_id,date:p.purchase_date,quantity:Number(p.quantity_base)} satisfies UsagePurchase)),
  staff:e?.staff??[],from:input.from,to:input.to,groupBy:input.groupBy??null});
 return {from:input.from,to:input.to,rows,groupBy:input.groupBy??null,
  missing:[...new Set(rows.flatMap(r=>r.missing))]};
}
/** Closing counts overwrite the same ingredient/date; purchases remain append-only. */
export async function saveUsageEntry(kind:"count"|"purchase",raw:unknown):Promise<{ok:true}|{ok:false;error:string}>{
 const parsed=stockInput.safeParse(raw);
 if(!parsed.success||kind==="purchase"&&parsed.data.quantity===0)return {ok:false,error:"invalid_quantity"};
 try{
  const {db,businessId}=await scope();
  const {data:ingredient,error:readError}=await db.from("ingredients").select("id,base_unit")
   .eq("business_id",businessId).eq("id",parsed.data.ingredientId).maybeSingle();
  if(readError||!ingredient)return {ok:false,error:"ingredient_not_found"};
  const quantity=packBaseQuantity(parsed.data.quantity,parsed.data.unit,ingredient.base_unit as BaseUnit);
  // A zero count is valid (an empty shelf), not missing.
  const inBase=parsed.data.quantity===0&&kind==="count"&&
   packBaseQuantity(1,parsed.data.unit,ingredient.base_unit as BaseUnit)!==null?0:quantity;
  if(inBase===null||!Number.isFinite(inBase)||inBase>1e9)return {ok:false,error:"invalid_unit"};
  const base={business_id:businessId,ingredient_id:ingredient.id,entered_quantity:parsed.data.quantity,
   entered_unit:parsed.data.unit,quantity_base:Math.round(inBase*10000)/10000};
  const result=kind==="count"?await db.from("pantry_stock_counts").upsert({
   ...base,count_date:parsed.data.date,updated_at:new Date().toISOString()
  },{onConflict:"business_id,ingredient_id,count_date"}):
  await db.from("pantry_stock_purchases").insert({...base,purchase_date:parsed.data.date});
  if(result.error)return {ok:false,error:"save_failed"};
  return {ok:true};
 }catch{return {ok:false,error:"save_failed"};}
}
