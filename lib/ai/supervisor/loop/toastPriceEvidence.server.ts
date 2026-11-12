import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";

/** The existing canonical receipt, not a local edit or owner Done, is the
 * only source allowed to activate a Toast-connected price experiment. */
export type VerifiedToastPriceEvidence={
 status:"verified";businessId:string;restaurantGuid:string;
 menuItemId:string;posItemId:string;historyId:string;
 oldPriceCents:number;newPriceCents:number;
 publicationVersion:string;observedAt:string;startAt:string;
 startBasis:"source_effective"|"first_verified_observation";
};
export type UnverifiedToastPriceEvidence={status:"unverified";reason:string};
type Candidate={
 businessId:string;menuItemId:string;targetCents:number;
 menu:{business_id:string;id:string;pos_item_id:string|null;
  catalog_source:string|null;price_cents:number|null;
  is_active:boolean;pos_pricing_strategy:string|null;
  toast_publication_state:string|null;toast_publication_version:string|null;
  toast_publication_observed_at:string|null};
 receipt:{restaurant_guid:string;verified_at:string|null;
  menu_last_updated:string|null;menu_copied_at:string|null};
 history:readonly {id:string;business_id:string;menu_item_id:string;
  old_price_cents:number|null;new_price_cents:number|null;
  source_type:string;source_provider:string|null;toast_restaurant_guid:string|null;
  toast_publication_version:string|null;toast_observed_at:string|null;
  toast_effective_at:string|null}[];
};
const guid="[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}";
const posPattern=new RegExp("^toast:("+guid+"):("+guid+")(?:\\:size\\:("+guid+"))?$","i");
const validTime=(value:string|null|undefined)=>
 typeof value==="string"&&Number.isFinite(Date.parse(value));
export function matchVerifiedToastPriceEvidence(input:Candidate):
 VerifiedToastPriceEvidence|UnverifiedToastPriceEvidence{
 const deny=(reason:string):UnverifiedToastPriceEvidence=>({status:"unverified",reason});
 const {businessId,menuItemId,menu,receipt,targetCents,history}=input;
 if(!Number.isSafeInteger(targetCents)||targetCents<=0||menu.business_id!==businessId||
    menu.id!==menuItemId||menu.catalog_source!=="toast"||!menu.is_active||
    menu.toast_publication_state!=="active")return deny("unverified_menu_identity");
 const parsed=menu.pos_item_id?.match(posPattern);
 if(!parsed||parsed[1].toLowerCase()!==receipt.restaurant_guid.toLowerCase())
  return deny("ambiguous_or_wrong_restaurant_item");
 const isSize=Boolean(parsed[3]);
 // Contextual/daypart/variable prices are not safe one-price observations.
 if(menu.pos_pricing_strategy!==(isSize?"SIZE_PRICE":"BASE_PRICE"))
  return deny("contextual_or_open_price");
 if(receipt.verified_at===null||!validTime(receipt.verified_at)||
    !menu.toast_publication_version||
    menu.toast_publication_version!==receipt.menu_last_updated||
    !validTime(receipt.menu_copied_at)||
    !validTime(menu.toast_publication_observed_at)||
    Date.parse(receipt.menu_copied_at!)<
     Date.parse(menu.toast_publication_observed_at!)-20*60000)
  return deny("missing_fresh_publication");
 if(menu.price_cents!==targetCents)return deny("target_not_published");
 const verified=history.filter(h=>h.business_id===businessId&&
   h.menu_item_id===menuItemId&&h.source_type==="connected_pos"&&
   h.source_provider==="toast"&&
   h.toast_restaurant_guid?.toLowerCase()===receipt.restaurant_guid.toLowerCase()&&
   h.toast_publication_version===menu.toast_publication_version&&
   validTime(h.toast_observed_at)&&validTime(menu.toast_publication_observed_at)&&
   Date.parse(h.toast_observed_at!)===Date.parse(menu.toast_publication_observed_at!)&&
   Number.isSafeInteger(h.old_price_cents)&&h.old_price_cents!>0&&
   h.new_price_cents===targetCents&&h.old_price_cents!==h.new_price_cents&&
   validTime(h.toast_observed_at));
 if(verified.length!==1)return deny(verified.length?"ambiguous_price_history":"no_verified_price_change");
 const event=verified[0];
 const effective=validTime(event.toast_effective_at)?event.toast_effective_at!:null;
 if(effective&&Date.parse(effective)>Date.parse(event.toast_observed_at!))
  return deny("future_source_effective_at");
 return {status:"verified",businessId,restaurantGuid:receipt.restaurant_guid,
  menuItemId,posItemId:menu.pos_item_id!,historyId:event.id,
  oldPriceCents:event.old_price_cents!,newPriceCents:targetCents,
  publicationVersion:menu.toast_publication_version!,
  observedAt:event.toast_observed_at!,startAt:effective??event.toast_observed_at!,
  startBasis:effective?"source_effective":"first_verified_observation"};
}
/** Only records already retained and source-stamped by POS0d are eligible.
 * The passed DB is the existing authorized, scoped server client. */
export async function readVerifiedToastPriceEvidence(db:SupabaseClient,
 businessId:string,menuItemId:string,targetCents:number):
 Promise<VerifiedToastPriceEvidence|UnverifiedToastPriceEvidence>{
 const {data:item,error:itemError}=await db.from("menu_items").select(
  "business_id,id,pos_item_id,catalog_source,price_cents,is_active,pos_pricing_strategy,toast_publication_state,toast_publication_version,toast_publication_observed_at")
  .eq("business_id",businessId).eq("id",menuItemId).maybeSingle();
 if(itemError)throw new Error("toast_price_source_read_failed");
 if(!item||typeof item.pos_item_id!=="string")return {status:"unverified",reason:"menu_item_missing"};
 const parsed=item.pos_item_id.match(posPattern);
 if(!parsed)return {status:"unverified",reason:"not_unambiguous_toast_identity"};
 const restaurantGuid=parsed[1];
 const [location,checkpoint,prices]=await Promise.all([
  db.from("toast_location_mappings").select("restaurant_guid,verified_at")
   .eq("business_id",businessId).eq("restaurant_guid",restaurantGuid).maybeSingle(),
  db.from("toast_optional_sync_state").select("menu_last_updated,menu_copied_at")
   .eq("business_id",businessId).eq("restaurant_guid",restaurantGuid).maybeSingle(),
  db.from("menu_price_history").select(
   "id,business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider,toast_restaurant_guid,toast_publication_version,toast_observed_at,toast_effective_at")
   .eq("business_id",businessId).eq("menu_item_id",menuItemId)
   .eq("source_type","connected_pos").eq("source_provider","toast")
   .eq("toast_restaurant_guid",restaurantGuid)
   .eq("toast_publication_version",item.toast_publication_version)
   .order("toast_observed_at",{ascending:false}).limit(25)
 ]);
 if(location.error||checkpoint.error||prices.error)
  throw new Error("toast_price_source_read_failed");
 if(!location.data||!checkpoint.data)
  return {status:"unverified",reason:"no_verified_restaurant_copy"};
 return matchVerifiedToastPriceEvidence({businessId,menuItemId,targetCents,
  menu:item,receipt:{...location.data,...checkpoint.data},
  history:prices.data??[]});
}
