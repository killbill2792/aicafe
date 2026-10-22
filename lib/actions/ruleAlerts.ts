"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
export async function dismissStaffRuleAlert(raw:unknown){
 const parsed=z.strictObject({id:z.string().uuid()}).safeParse(raw);
 if(!parsed.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();
 if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.from("staff_rule_alerts").update({status:"dismissed"})
  .eq("business_id",owner.businessId).eq("id",parsed.data.id).select("id").maybeSingle();
 if(error||!data)return {ok:false as const,error:"not_found"};
 revalidatePath("/staff");return {ok:true as const};
}
