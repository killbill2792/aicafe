import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {usageBusinessDay} from "@/lib/calc/usageDates";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { packBaseQuantity, toBaseUnitQuantity, type BaseUnit, type RecipeDisplayUnit } from "@/lib/calc/recipeUnits";
import { calculateUsage, type UsageIngredient, type UsageRecipe, type UsageSale, type UsageCount, type UsagePurchase, type UsageStaff, type UsageRow } from "@/lib/calc/usageVariance";
import {scopedModifierId,scopedToastModifierRecipes,sizedMilkReplacementQuantity} from "@/lib/calc/usageModifierResolution";

const iso=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!Number.isNaN(Date.parse(s+"T00:00:00Z")));
const readInput=z.strictObject({
 from:iso,to:iso,ingredient:z.string().max(100).nullable().optional(),
 groupBy:z.enum(["day","shift","staff"]).nullable().optional()
}).refine(v=>v.to>=v.from&& (Date.parse(v.to)-Date.parse(v.from))/86400000<=30);
const stockInput=z.strictObject({
 ingredientId:z.string().uuid(),date:iso,quantity:z.number().finite().nonnegative().max(1000000000),
 unit:z.string().min(1).max(40),lineId:z.string().uuid().optional()
});
async function scope(explicit?:{client:SupabaseClient;businessId:string}){
  if(explicit)return {db:explicit.client,businessId:explicit.businessId};
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 if(!user)throw new Error("sign_in_required");
 const businessId=await getActiveBusinessId(user.id);
 const {data:membership,error}=await db.from("memberships").select("role")
  .eq("user_id",user.id).eq("business_id",businessId).maybeSingle();
 if(error||membership?.role!=="owner")throw new Error("owner_required");
 return {db,businessId};
}
/** Owner-scoped source of today's date for closing stock and default windows. */
export async function readUsageBusinessDate():Promise<string>{
 const {db,businessId}=await scope();
 const {data,error}=await db.from("businesses").select("timezone").eq("id",businessId).single();
 if(error||!data?.timezone)throw new Error("usage_timezone_unavailable");
 return usageBusinessDay(new Date(),data.timezone);
}
async function allRows<T>(load:(first:number,last:number)=>PromiseLike<{data:T[]|null;error:unknown}>,max=20000):Promise<T[]>{
 const all:T[]=[];
 for(let offset=0;offset<max;offset+=500){
  const pageSize=Math.min(500,max-offset);
  const {data,error}=await load(offset,offset+pageSize-1);
  if(error||!data){
   const code=error&&typeof error==="object"&&"code" in error?String(error.code):"";
   throw new Error(code==="57014"?"usage_source_timeout":"usage_data_unavailable");
  }
  if(data.length>pageSize)throw new Error("usage_rows_exceed_safe_limit");
  all.push(...data);
  if(data.length<pageSize)return all;
 }
 // An exactly full final page must not silently conceal further source rows.
 throw new Error("usage_rows_exceed_safe_limit");
}

/** Fetch order IDs from the café/date-indexed parent BEFORE reading lines.
 * The former child-first relational filter scanned the global id-ordered
 * order_lines table and timed out for October 2026 at page zero.
 * Every child batch is restricted to IDs returned by the owner/RLS-scoped
 * orders query. Keep the source cap and verify parent membership defensively. */
export async function readUsageOrderLines<O extends {id:string},L extends {order_id:string}>(
 orders:readonly O[],
 read:(orderIds:string[],first:number,last:number)=>PromiseLike<{data:L[]|null;error:unknown}>,
 maxLines=20000
):Promise<Array<L&{orders:O}>>{
 const byId=new Map(orders.map(o=>[o.id,o]));
 if(byId.size!==orders.length)throw new Error("usage_order_ids_not_unique");
 const result:Array<L&{orders:O}>=[];
 for(let start=0;start<orders.length;start+=400){
  const batches:O[][]=[];
  for(let offset=start;offset<Math.min(start+400,orders.length);offset+=100)
   batches.push(orders.slice(offset,offset+100));
  const chunks=await Promise.all(batches.map(batch=>
   allRows((first,last)=>read(batch.map(o=>o.id),first,last),maxLines)));
  for(const chunk of chunks)for(const line of chunk){
   const order=byId.get(line.order_id);
   if(!order)throw new Error("usage_source_scope_mismatch");
   if(result.length>=maxLines)throw new Error("usage_rows_exceed_safe_limit");
   result.push({...line,orders:order});
  }
 }
 return result;
}
/** UI and Maya use this same owner-scoped read; no LLM/client-supplied business ID. */
export async function readUsageVariance(raw:z.input<typeof readInput>, explicit?:{client:SupabaseClient;businessId:string}):Promise<{from:string;to:string;rows:UsageRow[];missing:string[];groupBy:string|null;provenance:{sales:string;recipes:string;counts:string;purchases:string;coverage:"complete"|"incomplete"}}>{
 const input=readInput.parse(raw);
 const {db,businessId}=await scope(explicit);
 const {data:ingredients,error:ie}=await db.from("ingredients").select("id,name,base_unit,category")
  .eq("business_id",businessId).order("name").limit(1000);
 if(ie||!ingredients)throw new Error("usage_ingredients_unavailable");
 const selected=ingredients.filter(i=>!input.ingredient||
  i.id===input.ingredient||i.name.toLowerCase().includes(input.ingredient.toLowerCase()));
 const allIds=ingredients.map(i=>i.id),chosenIds=selected.map(i=>i.id);
 const [evidence,recipes,modifiers,addons,conversions,counts,purchases,orders] = await Promise.all([
  db.rpc("pantry_usage_sales_evidence",{p_business_id:businessId,p_from:input.from,p_to:input.to}),
  allRows((a,b)=>db.from("recipe_lines").select("menu_item_id,ingredient_id,quantity,menu_items!inner(business_id)")
   .eq("menu_items.business_id",businessId).order("menu_item_id").order("ingredient_id").range(a,b),8000),
  db.from("modifier_recipes").select("id,pos_modifier_id,name,ingredient_id,quantity_delta,replaces_ingredient_id").eq("business_id",businessId).limit(2000),
  db.from("menu_product_addons").select("menu_item_id,ingredient_id,kind,is_default,enabled,display_unit,display_quantity")
   .eq("business_id",businessId).limit(3000),
  allIds.length?db.from("ingredient_unit_conversions").select("ingredient_id,unit,base_units_per_unit").in("ingredient_id",allIds).limit(3000):Promise.resolve({data:[],error:null}),
  chosenIds.length?db.from("pantry_stock_counts").select("ingredient_id,count_date,quantity_base")
   .eq("business_id",businessId).in("ingredient_id",chosenIds).in("count_date",[input.to,new Date(Date.parse(input.from+"T12:00:00Z")-86400000).toISOString().slice(0,10)]):Promise.resolve({data:[],error:null}),
  chosenIds.length?allRows((a,b)=>db.from("pantry_stock_purchases").select("ingredient_id,purchase_date,quantity_base")
    .eq("business_id",businessId).in("ingredient_id",chosenIds).gte("purchase_date",input.from).lte("purchase_date",input.to).is("voided_at",null)
    .order("id").range(a,b),8000):Promise.resolve([]),
  allRows((a,b)=>db.from("orders").select("id,business_date,closed_at,pos_order_id,location_id")
    .eq("business_id",businessId).gte("business_date",input.from).lte("business_date",input.to)
    .eq("toast_excluded",false).is("superseded_by",null)
    .order("id").range(a,b),20000),
 ]);
 if(evidence.error||modifiers.error||addons.error||conversions.error||counts.error||!modifiers.data||!addons.data||!conversions.data||!counts.data)
  throw new Error("usage_data_unavailable");
 const sales=await readUsageOrderLines(orders,(ids,a,b)=>
  db.from("order_lines").select("id,order_id,menu_item_id,quantity,modifiers,voided")
   .in("order_id",ids).order("id").range(a,b),20000);
 const e=evidence.data as {covered?:boolean;staff?:UsageStaff[];
  modifierMappings?:Array<{restaurantGuid?:string;locationRef?:string;provider?:"toast"|"square"|"csv";posModifierId:string;recipeId:string}>}|null;
 const mappedMods=scopedToastModifierRecipes(e?.modifierMappings??[],modifiers.data.map(m=>({
  id:m.id,ingredientId:m.ingredient_id,quantityDelta:Number(m.quantity_delta),
  replacesIngredientId:m.replaces_ingredient_id,posModifierId:m.pos_modifier_id
 })));
 const recipesByItem=new Map<string,typeof recipes>();
 for(const r of recipes){
  const lines=recipesByItem.get(r.menu_item_id)??[];
  lines.push(r);recipesByItem.set(r.menu_item_id,lines);
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
  const order=s.orders as unknown as {
   closed_at:string|null;business_date:string;location_id:string|null;pos_order_id:string|null;
  };
  const providerOrderId=order.pos_order_id??"";
  // The persisted Toast order ID carries the restaurant identity, whereas
  // an individual option GUID has no business-wide uniqueness guarantee.
  const restaurantGuid=providerOrderId.match(/^toast:([0-9a-f-]{36}):/i)?.[1]??null;
  const sizeRecipe=recipesByItem.get(s.menu_item_id??"")??[];
  const savedMods=Array.isArray(s.modifiers)?s.modifiers as Array<{posModifierId?:string;name?:string;quantity?:number;priceCents?:number|null;parentPosModifierId?:string|null}>:[];
  const optionRows=addonsByItem.get(s.menu_item_id??"")??[];
  const normalized=savedMods.map((m,index)=>{
   const key=String(m.posModifierId??"");
   const provider=providerOrderId.startsWith("toast:")?"toast":
     providerOrderId.startsWith("square:")?"square":"csv";
   const locationRef=provider==="toast"?restaurantGuid:
     provider==="square"?order.location_id:order.location_id??"csv";
   const scoped=scopedModifierId(provider,locationRef,key);
   const metadata={name:m.name??"",quantity:m.quantity??1,priceCents:m.priceCents??null,
     parentPosModifierId:m.parentPosModifierId?scopedModifierId(provider,locationRef,m.parentPosModifierId):null};
   if(scoped&&mappedMods.has(scoped))return {posModifierId:scoped,...metadata};
   const matches=optionRows.filter(a=>a.enabled&&
    ingredientById.get(a.ingredient_id)?.name.toLowerCase()===String(m.name??"").trim().toLowerCase());
   if(matches.length===1){
    const match=matches[0],ingredient=ingredientById.get(match.ingredient_id)!;
    const defaultMilk=optionRows.find(a=>a.kind==="milk"&&a.is_default);
    const recipeMilk=sizeRecipe.filter(line=>ingredientById.get(line.ingredient_id)?.category==="milk");
    const sourceMilkId=defaultMilk&&sizeRecipe.some(line=>line.ingredient_id===defaultMilk.ingredient_id)
      ?defaultMilk.ingredient_id:recipeMilk.length===1?recipeMilk[0].ingredient_id:null;
    const sourceMilk=sourceMilkId?ingredientById.get(sourceMilkId):null;
    const qty=match.kind==="milk"
      ?sourceMilk&&sourceMilkId?sizedMilkReplacementQuantity(
         sizeRecipe.map(line=>({ingredientId:line.ingredient_id,quantity:Number(line.quantity)})),
         sourceMilkId,sourceMilk.base_unit,ingredient.base_unit):null
      :toBaseUnitQuantity(match.display_unit as RecipeDisplayUnit,Number(match.display_quantity),
        ingredient.base_unit as BaseUnit,conversionByIngredient.get(match.ingredient_id)??[]);
    // Missing sold-size milk portions remain unverified, not a placeholder 1 ml.
    if(qty!==null&&(match.kind!=="milk"||sourceMilkId)){
     const synthetic="addon:"+s.id+":"+index;
     mappedMods.set(synthetic,{posModifierId:synthetic,ingredientId:match.ingredient_id,
      quantityDelta:qty,replacesIngredientId:match.kind==="milk"?sourceMilkId:null});
     return {posModifierId:synthetic,...metadata};
    }
   }
   // Do not accidentally match Toast modifiers with generic names across items.
   return {posModifierId:key||"unmapped:"+s.id+":"+index,...metadata};
  });
  return {sourceLineId:s.id,menuItemId:s.menu_item_id,quantity:Number(s.quantity),businessDate:order.business_date,
   // An open/unclosed POS order has no verified close time; an empty value
   // deliberately matches no timecard rather than inventing a timestamp.
   closedAt:order.closed_at??"",locationId:order.location_id,modifiers:normalized};
 });
 // Missing recipes are a separate source coverage defect from unknown pantry
 // prices or stock counts. Do not label a catalog item with no recipe as a
 // known zero-cost item, or conflate it with a failed SQL read.
 const soldMenuItemsWithoutRecipe=new Set(sales.filter(s=>!s.voided&&
  s.menu_item_id&&!recipesByItem.has(s.menu_item_id)).map(s=>s.menu_item_id));
 const rows=calculateUsage({ingredients:selected.map(i=>({id:i.id,name:i.name,unit:i.base_unit as UsageIngredient["unit"]})),
  recipes:recipes.map(r=>({menuItemId:r.menu_item_id,ingredientId:r.ingredient_id,quantity:Number(r.quantity)} satisfies UsageRecipe)),
  modifiers:[...mappedMods.values()],sales:salesRows,salesCovered:e?.covered===true,
  counts:counts.data.map(c=>({ingredientId:c.ingredient_id,date:c.count_date,quantity:Number(c.quantity_base)} satisfies UsageCount)),
  purchases:purchases.map(p=>({ingredientId:p.ingredient_id,date:p.purchase_date,quantity:Number(p.quantity_base)} satisfies UsagePurchase)),
  staff:e?.staff??[],from:input.from,to:input.to,groupBy:input.groupBy??null});
 return {from:input.from,to:input.to,rows,groupBy:input.groupBy??null,
  provenance:{sales:"canonical_order_lines",recipes:"owner_recipe_lines",
   counts:"dated_owner_stock_counts",purchases:"nonvoid_purchase_lines",
   coverage:e?.covered===true?"complete":"incomplete"},
  missing:[...new Set([...rows.flatMap(r=>r.missing),
   ...(soldMenuItemsWithoutRecipe.size?["soldMenuItemsWithoutRecipes:"+soldMenuItemsWithoutRecipe.size]:[])])]};
}
/** Closing counts overwrite an ingredient/date; purchases use a stable line ID. */
export async function saveUsageEntry(kind:"count"|"purchase",raw:unknown):Promise<{ok:true}|{ok:false;error:string}>{
 const parsed=stockInput.safeParse(raw);
 if(!parsed.success||kind==="purchase"&&parsed.data.quantity===0)return {ok:false,error:"invalid_quantity"};
 try{
  const {db,businessId}=await scope();
  const {data:ingredient,error:readError}=await db.from("ingredients").select("id,base_unit,archived_at")
   .eq("business_id",businessId).eq("id",parsed.data.ingredientId).maybeSingle();
  // Counts and new manual purchases are not historical edits. A stale or
  // forged archived ingredient ID must fail closed before any upsert/write.
  if(readError||!ingredient||ingredient.archived_at)return {ok:false,error:"ingredient_not_found"};
  const quantity=packBaseQuantity(parsed.data.quantity,parsed.data.unit,ingredient.base_unit as BaseUnit);
  // A zero count is valid (an empty shelf), not missing.
  const inBase=parsed.data.quantity===0&&kind==="count"&&
   packBaseQuantity(1,parsed.data.unit,ingredient.base_unit as BaseUnit)!==null?0:quantity;
  if(inBase===null||!Number.isFinite(inBase)||inBase>1e9)return {ok:false,error:"invalid_unit"};
  const base={business_id:businessId,ingredient_id:ingredient.id,entered_quantity:parsed.data.quantity,
   entered_unit:parsed.data.unit,quantity_base:Math.round(inBase*10000)/10000};
  if(kind==="purchase"){
   const {recordPurchases}=await import("@/lib/inventory/recordPurchases.server");
   const result=await recordPurchases([{
    lineId:parsed.data.lineId??crypto.randomUUID(),ingredientId:ingredient.id,date:parsed.data.date,
    quantity:parsed.data.quantity,unit:parsed.data.unit,costCents:null
   }],"manual",null);
   if(!result[0]?.ok)return {ok:false,error:result[0]?.error??"save_failed"};
  }else{
   const result=await db.from("pantry_stock_counts").upsert({
    ...base,count_date:parsed.data.date,updated_at:new Date().toISOString()
   },{onConflict:"business_id,ingredient_id,count_date"});
   if(result.error)return {ok:false,error:"save_failed"};
  }
  return {ok:true};
 }catch{return {ok:false,error:"save_failed"};}
}
