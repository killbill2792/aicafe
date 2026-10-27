"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
const schema=z.strictObject({
 ingredientPercent:z.number().min(0).max(99.99).nullable(),
 ownerMonthlyPayrollExtrasCents:z.number().int().safe().nonnegative().nullable()
});
/** A trusted café owner explicitly saves financial assumptions. An unknown
 * amount is stored NULL, never as a $0 placeholder. */
export async function saveSupervisorFinancialSettings(raw:unknown):
 Promise<{ok:true}|{ok:false;error:"invalid"|"unauthorized"|"save_failed"}>{
 const parsed=schema.safeParse(raw);
 if(!parsed.success)return {ok:false,error:"invalid"};
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 if(!user)return {ok:false,error:"unauthorized"};
 const businessId=await getActiveBusinessId(user.id);
 const {data:membership,error}=await db.from("memberships").select("role")
  .eq("user_id",user.id).eq("business_id",businessId).maybeSingle();
 if(error||membership?.role!=="owner")return {ok:false,error:"unauthorized"};
 const {data:business,error:businessError}=await db.from("businesses").select("is_demo")
  .eq("id",businessId).single();
 if(businessError||business?.is_demo!==false)return {ok:false,error:"unauthorized"};
 const {error:writeError}=await db.from("businesses").update({
  target_ingredient_cost_rate:parsed.data.ingredientPercent===null?null:
   Number((parsed.data.ingredientPercent/100).toFixed(6)),
  target_ingredient_cost_rate_status:parsed.data.ingredientPercent===null?"missing":"owner",
  owner_monthly_payroll_extras_cents:parsed.data.ownerMonthlyPayrollExtrasCents,
  owner_monthly_payroll_extras_updated_at:new Date().toISOString()
 }).eq("id",businessId);
 if(writeError)return {ok:false,error:"save_failed"};
 for(const path of ["/more/financial-settings","/money","/menu","/more/plan","/"]){
  revalidatePath(path);
 }
 return {ok:true};
}
