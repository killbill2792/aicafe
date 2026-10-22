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
