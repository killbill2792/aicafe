"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
const schema=z.strictObject({name:z.string().trim().min(1).max(60),category:z.enum(["coffee","milk","syrup","sauce","powder","tea","packaging","bakery","food","other"]),baseUnit:z.enum(["g","ml","each"])});
export async function createPantryIngredient(input:z.infer<typeof schema>):Promise<{ok:true}|{ok:false;error:string}>{
 const parsed=schema.safeParse(input);if(!parsed.success)return{ok:false,error:"invalid_input"};
 const db=await createServerSupabaseClient();const {data:{user}}=await db.auth.getUser();if(!user)return{ok:false,error:"sign_in_required"};
 const businessId=await getActiveBusinessId(user.id);if(!businessId)return{ok:false,error:"sign_in_required"};
 const {error}=await db.from("ingredients").insert({business_id:businessId,name:parsed.data.name,category:parsed.data.category,base_unit:parsed.data.baseUnit});
 if(error)return{ok:false,error:"save_failed"};revalidatePath("/menu/pantry");return{ok:true};
}

export async function updatePantryIngredient(input:{id:string;name:string;category:z.infer<typeof schema>["category"]}):Promise<{ok:true}|{ok:false;error:string}>{
 const parsed=z.strictObject({id:z.string().uuid(),name:z.string().trim().min(1).max(60),category:schema.shape.category}).safeParse(input);
 if(!parsed.success)return{ok:false,error:"invalid_input"};
 const db=await createServerSupabaseClient();const {data:{user}}=await db.auth.getUser();
 const businessId=user?await getActiveBusinessId(user.id):null;if(!businessId)return{ok:false,error:"sign_in_required"};
 const {data,error}=await db.from("ingredients").update({name:parsed.data.name,category:parsed.data.category})
 .eq("business_id",businessId).eq("id",parsed.data.id).select("id");
 if(error||!data?.length)return{ok:false,error:"save_failed"};
 revalidatePath("/menu/pantry");revalidatePath("/menu");return{ok:true};
}
