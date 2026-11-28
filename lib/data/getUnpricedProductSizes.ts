import "server-only";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
export type UnpricedMenuSize={id:string;sizeLabel:string|null;name:string};
export async function getUnpricedProductSizes(itemId:string):Promise<UnpricedMenuSize[]>{
 const db=await createServerSupabaseClient(),{data:{user}}=await db.auth.getUser();
 const businessId=user?await getActiveBusinessId(user.id):null;if(!businessId)return [];
 const {data:current,error:readError}=await db.rpc("menu_catalog_for",{p_business_id:businessId})
  .select("base_name").eq("id",itemId).single();
 if(readError||!current)return [];
 const {data,error}=await db.rpc("menu_catalog_for",{p_business_id:businessId})
  .select("id,name,size_label,price_cents").eq("base_name",current.base_name).is("price_cents",null).order("size_label");
 if(error||!Array.isArray(data))return [];
 return data.map(item=>({id:item.id,name:item.name,sizeLabel:item.size_label??null}));
}
