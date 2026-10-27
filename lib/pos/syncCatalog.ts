import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PosAdapter,PosCatalogItem} from "./types";
import {matchCatalogItem,type CanonicalMenuCandidate} from "./catalogMatching";
import {recordInitialMenuPrice,setCanonicalMenuPrice} from "@/lib/menu/priceHistory";

type Row={id:string;pos_item_id:string|null;name:string;base_name:string|null;size_label:string|null;
 price_cents:number|null;category:string|null;catalog_source:string|null;pos_name:string|null;
 is_active:boolean;description:string|null;menu_group:string|null;pos_visibility:string|null;
 pos_pricing_strategy:string|null;pos_archived_at:string|null;pos_metadata:Record<string,unknown>|null};
const same=(a:unknown,b:unknown)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const pick=(current:object,desired:object)=>
 Object.fromEntries(Object.entries(desired).filter(([k,v])=>!same((current as Record<string,unknown>)[k],v)));
const resultError=(error:unknown)=>{if(error)throw error;};
const normalized=(v:string|null|undefined)=>(v??"").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();

/** Never let provider identity replace the owner/CSV identity without an alias. */
export async function syncCanonicalCatalog(db:SupabaseClient,businessId:string,adapter:PosAdapter,
 options:{restaurantGuid?:string}={}){
 const imported=await adapter.fetchCatalogItems();
 const {data,error}=await db.from("menu_items")
 .select("id,pos_item_id,name,base_name,size_label,price_cents,category,catalog_source,pos_name,is_active,description,menu_group,pos_visibility,pos_pricing_strategy,pos_archived_at,pos_metadata")
 .eq("business_id",businessId);
 resultError(error);
 const rows=(data??[]) as Row[];
 const {data:aliasRows,error:aliasesError}=await db.from("pos_item_aliases")
 .select("menu_item_id,provider,pos_item_id").eq("business_id",businessId);
 resultError(aliasesError);
 const alias=new Map((aliasRows??[]).map(r=>[r.provider+":"+r.pos_item_id,r.menu_item_id]));
 const byId=new Map(rows.map(r=>[r.id,r]));
 const candidates=():CanonicalMenuCandidate[]=>([...byId.values()].map(r=>({
  id:r.id,name:r.name,baseName:r.base_name,sizeLabel:r.size_label,priceCents:r.price_cents,
  category:r.category,posItemId:r.pos_item_id,catalogSource:r.catalog_source??"manual"
 })));
 let matched=0,needsReview=0,created=0,changed=0;
 const seen=new Set<string>();
 for(const item of imported){
  if(seen.has(item.posItemId))continue;
  seen.add(item.posItemId);
  let row=[...byId.values()].find(x=>x.pos_item_id===item.posItemId);
  const aliased=alias.get(adapter.provider+":"+item.posItemId);
  if(!row&&aliased)row=byId.get(aliased);
  let match:ReturnType<typeof matchCatalogItem>|null=null;
  if(!row){
   match=matchCatalogItem(item,candidates());
   if(match.status==="needs_review"){
    needsReview++;
    const {error:reviewError}=await db.from("pos_catalog_matches").upsert({
      business_id:businessId,provider:adapter.provider,pos_item_id:item.posItemId,
      imported_name:item.name,imported_price_cents:item.priceCents,
      imported_category:item.category,suggested_menu_item_id:match.candidateId,
      match_score:match.score,status:"needs_review"
    },{onConflict:"business_id,provider,pos_item_id"});
    resultError(reviewError);
    continue;
   }
   if(match.candidateId)row=byId.get(match.candidateId);
  }
  const desired={
   base_name:item.baseName??item.name,size_label:item.sizeLabel??null,
   category:item.category,menu_group:item.menuGroup??null,description:item.description??null,
   pos_visibility:item.visibility??null,pos_pricing_strategy:item.pricingStrategy??null,
   pos_name:item.name,pos_metadata:item.posMetadata??{},
   is_active:true,pos_archived_at:null
  };
  let itemId:string;
  if(row){
   matched++;itemId=row.id;
   // If the owner renamed the item after the last provider import, preserve it.
   const preserveName=row.pos_name===null?
    (row.catalog_source==="manual"||row.catalog_source==="csv"):
    row.name!==row.pos_name;
   const patch=pick(row,{...desired,
    ...(!preserveName?{name:item.name}:{}),
    // A linked POS identity is canonical; CSV's historical ID becomes an alias.
    pos_item_id:item.posItemId,catalog_source:adapter.provider
   } as Partial<Row>);
   if(row.pos_item_id&&row.pos_item_id!==item.posItemId){
    const previousProvider=row.pos_item_id.startsWith("csv-item-")?"csv":
      row.catalog_source??adapter.provider;
    const {error:aliasError}=await db.from("pos_item_aliases").upsert({
      business_id:businessId,menu_item_id:itemId,provider:previousProvider,pos_item_id:row.pos_item_id
    },{onConflict:"business_id,provider,pos_item_id"});
    resultError(aliasError);
   }
   if(Object.keys(patch).length){
    const {error:updateError}=await db.from("menu_items").update({
     ...patch,catalog_last_synced_at:new Date().toISOString()
    }).eq("business_id",businessId).eq("id",row.id);
    resultError(updateError);changed++;
    byId.set(row.id,{...row,...patch} as Row);
   }
  }else{
   const {data:createdRow,error:createError}=await db.from("menu_items").upsert({
    business_id:businessId,pos_item_id:item.posItemId,name:item.name,
    ...desired,price_cents:item.priceCents,catalog_source:adapter.provider,
    catalog_last_synced_at:new Date().toISOString()
   },{onConflict:"business_id,pos_item_id"}).select("id").single();
   resultError(createError);if(!createdRow)throw new Error("POS item upsert failed");
   itemId=createdRow.id;created++;changed++;
   byId.set(itemId,{...desired,id:itemId,pos_item_id:item.posItemId,name:item.name,
     price_cents:item.priceCents,catalog_source:adapter.provider,
     catalog_last_synced_at:new Date().toISOString()} as unknown as Row);
   if(item.priceCents!==null&&item.priceCents>0)await recordInitialMenuPrice(db,{
    businessId,menuItemId:itemId,priceCents:item.priceCents,sourceProvider:adapter.provider
   });
  }
  if(row&&item.priceCents===null&&row.price_cents!==null){
   // Toast OPEN_PRICE means unknown, not a stale historical fixed price.
   const {error:clearPriceError}=await db.from("menu_items").update({
    price_cents:null
   }).eq("business_id",businessId).eq("id",itemId);
   resultError(clearPriceError);
   const updated=byId.get(itemId);if(updated)updated.price_cents=null;
   changed++;
  }
  if(row&&item.priceCents!==null&&row.price_cents!==item.priceCents){
   await setCanonicalMenuPrice(db,{businessId,menuItemId:itemId,
    priceCents:item.priceCents,sourceType:adapter.provider==="csv"?"imported":"connected_pos",
    sourceProvider:adapter.provider});
   const updated=byId.get(itemId);if(updated)updated.price_cents=item.priceCents;
   changed++;
  }
  if(item.modifierGroups){
   const {data:oldGroups,error:oldError}=await db.from("menu_item_modifier_groups")
    .select("pos_group_id,pos_group_name,min_selections,max_selections,required")
    .eq("business_id",businessId).eq("menu_item_id",itemId);
   resultError(oldError);
   const previous=new Map((oldGroups??[]).map(g=>[g.pos_group_id,g]));
   const groupIds:string[]=[];
   for(const group of item.modifierGroups){
    groupIds.push(group.posGroupId);
    const groupValues={pos_group_name:group.name,min_selections:group.minSelections,
     max_selections:group.maxSelections,required:group.required};
    const prior=previous.get(group.posGroupId);
    if(!prior||!same(Object.fromEntries(Object.keys(groupValues).map(
     k=>[k,prior[k as keyof typeof prior]])),groupValues)){
     const {error:gError}=await db.from("menu_item_modifier_groups").upsert({
      business_id:businessId,menu_item_id:itemId,pos_group_id:group.posGroupId,
      ...groupValues
     },{onConflict:"business_id,menu_item_id,pos_group_id"});
     resultError(gError);changed++;
    }
    for(const option of group.options){
     const {data:existing,error:readError}=await db.from("modifier_recipes")
       .select("id,name,price_cents,pos_group_id,pos_group_name,is_active")
       .eq("business_id",businessId).eq("pos_modifier_id",option.posModifierId).maybeSingle();
     resultError(readError);
     const values={name:option.name,price_cents:option.priceCents,
      pos_group_id:group.posGroupId,pos_group_name:group.name,is_active:true};
     if(!existing){
      const {error:modifierError}=await db.from("modifier_recipes").upsert({
       business_id:businessId,pos_modifier_id:option.posModifierId,...values,
       catalog_source:adapter.provider,catalog_last_synced_at:new Date().toISOString()
      },{onConflict:"business_id,pos_modifier_id"});
      resultError(modifierError);changed++;
     }else if(!same(Object.fromEntries(Object.keys(values).map(k=>[k,existing[k as keyof typeof existing]])),values)){
      const {error:modifierError}=await db.from("modifier_recipes").update({
       ...values,catalog_last_synced_at:new Date().toISOString()
      }).eq("business_id",businessId).eq("id",existing.id);
      resultError(modifierError);changed++;
     }
    }
   }
   for(const old of oldGroups??[])if(!groupIds.includes(old.pos_group_id)){
    const {error:delError}=await db.from("menu_item_modifier_groups").delete()
      .eq("business_id",businessId).eq("menu_item_id",itemId).eq("pos_group_id",old.pos_group_id);
    resultError(delError);changed++;
   }
  }
  if(adapter.provider==="toast"){
   const baseId=item.posItemId.split(":size:")[0].split(":").at(-1)??"";
   const guid=baseId;
   if(/^[0-9a-f-]{36}$/i.test(guid)){
    const {error:linkErr}=await db.from("toast_catalog_facts")
     .update({linked_menu_item_id:itemId})
     .eq("business_id",businessId).eq("kind","item").eq("provider_guid",guid)
     .is("linked_menu_item_id",null);
    resultError(linkErr);
   }
  }
 }
 // A complete menu snapshot archives only published items owned by this same provider.
 if(adapter.provider!=="csv"){
  for(const row of rows){
   // Toast snapshots are restaurant-specific. Never archive another location's
   // published menu merely because it wasn't in this restaurant's response.
   if(adapter.provider==="toast"&&
      (!options.restaurantGuid||!row.pos_item_id?.startsWith("toast:"+options.restaurantGuid+":")))
     continue;
   if(row.catalog_source!==adapter.provider||!row.pos_item_id||seen.has(row.pos_item_id)||!row.is_active)continue;
   const {error:archError}=await db.from("menu_items").update({
    is_active:false,pos_archived_at:new Date().toISOString()
   }).eq("business_id",businessId).eq("id",row.id);
   resultError(archError);changed++;
  }
 }
 if(adapter.provider==="toast"&&(options.restaurantGuid||imported.length)){
  const restaurantGuid=options.restaurantGuid??imported[0].posItemId.split(":")[1];
  const {error:relinkError}=await db.rpc("pos_relink_toast_lines",{
   p_business_id:businessId,p_restaurant_guid:restaurantGuid
  });resultError(relinkError);
 }
 return {imported:imported.length,matched,needsReview,created,changed};
}
