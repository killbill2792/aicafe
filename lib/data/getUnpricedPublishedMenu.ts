import "server-only";
import {isSupabaseConfigured} from "@/lib/supabase/client";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "./getActiveBusinessId";
import {readAllPosRows,posIdBatches} from "@/lib/pos/pagedReads";

export type UnpricedPublishedItem={
 id:string;name:string;baseName:string;sizeLabel:string|null;
 menuGroup:string|null;category:string|null;description:string|null;
 visibility:string|null;pricingStrategy:string|null;
 addons:{name:string;groupName:string;priceCents:number|null}[];
};

/** The priced-margin engine cannot accept a null selling price. Keep these
 * published Toast items visible without coalescing unknown/open prices to $0.
 * This view never invents an amount and never changes recipes.
 */
export async function getUnpricedPublishedMenu():Promise<UnpricedPublishedItem[]>{
 if(!isSupabaseConfigured())return [];
 const db=await createServerSupabaseClient();
 const {data:{user},error:authError}=await db.auth.getUser();
 if(authError)throw authError;
 if(!user)return [];
 const businessId=await getActiveBusinessId(user.id);
 const items=await readAllPosRows((from,to)=>db.from("menu_items")
  .select("id,name,base_name,size_label,category,menu_group,description,pos_visibility,pos_pricing_strategy")
  .eq("business_id",businessId).eq("is_active",true)
  .is("price_cents",null).order("id").range(from,to),"unpriced menu items");
 if(items.length===0)return [];
 const links: {menu_item_id:string;pos_group_id:string;pos_group_name:string|null}[]=[];
 for(const batch of posIdBatches(items.map(item=>item.id))){
  links.push(...await readAllPosRows((from,to)=>db.from("menu_item_modifier_groups")
   .select("menu_item_id,pos_group_id,pos_group_name")
   .eq("business_id",businessId).in("menu_item_id",batch)
   .order("menu_item_id").order("pos_group_id").range(from,to),"item modifier groups"));
 }
 const groups=[...new Set(links.map(link=>link.pos_group_id))];
 const modifiers:{pos_group_id:string|null;name:string;price_cents:number|null;is_active:boolean}[]=[];
 for(const batch of posIdBatches(groups)){
  modifiers.push(...await readAllPosRows((from,to)=>db.from("modifier_recipes")
   .select("pos_group_id,name,price_cents,is_active").eq("business_id",businessId)
   .in("pos_group_id",batch).order("id").range(from,to),"published modifier prices"));
 }
 const optionsByGroup=new Map<string,{name:string;priceCents:number|null}[]>();
 for(const modifier of modifiers){
  if(!modifier.is_active||!modifier.pos_group_id)continue;
  const existing=optionsByGroup.get(modifier.pos_group_id)??[];
  existing.push({name:modifier.name,priceCents:modifier.price_cents});
  optionsByGroup.set(modifier.pos_group_id,existing);
 }
 const linksByItem=new Map<string,typeof links>();
 for(const link of links){
  const current=linksByItem.get(link.menu_item_id)??[];
  current.push(link);linksByItem.set(link.menu_item_id,current);
 }
 return items.map(item=>({
  id:item.id,name:item.name,baseName:item.base_name??item.name,
  sizeLabel:item.size_label,menuGroup:item.menu_group,category:item.category,
  description:item.description,visibility:item.pos_visibility,
  pricingStrategy:item.pos_pricing_strategy,
  addons:(linksByItem.get(item.id)??[]).flatMap(group=>
   (optionsByGroup.get(group.pos_group_id)??[]).map(option=>({
    name:option.name,groupName:group.pos_group_name??"",priceCents:option.priceCents
   })))
 }));
}
