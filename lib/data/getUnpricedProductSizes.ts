import "server-only";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
export type UnpricedMenuSize={id:string;sizeLabel:string|null;name:string};
export async function getUnpricedProductSizes(itemId:string):Promise<UnpricedMenuSize[]>{
 const db=await createServerSupabaseClient(),{data:{user}}=await db.auth.getUser();
 const businessId=user?await getActiveBusinessId(user.id):null;if(!businessId)return [];
 const {data:current,error:readError}=await db.from("menu_items").select("base_name").eq("business_id",businessId).eq("id",itemId).single();
 if(readError||!current)return [];
 const {data,error}=await db.from("menu_items").select("id,name,size_label,price_cents")
 .eq("business_id",businessId).eq("base_name",current.base_name).is("price_cents",null).order("size_label");
 if(error||!data)return [];
 return data.map(item=>({id:item.id,name:item.name,sizeLabel:item.size_label??null}));
}
