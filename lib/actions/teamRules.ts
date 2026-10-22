"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
const DEFAULT_TEAM_RULES={
 meal_break_enabled:true,meal_break_minutes:30,meal_break_after_minutes:300,
 rest_break_enabled:true,rest_break_minutes:10,rest_break_every_minutes:240,
 weekly_ot_enabled:true,weekly_ot_after_minutes:2400,ot_multiplier_bp:15000,
 daily_ot_enabled:false,daily_ot_after_minutes:480,
 max_shift_enabled:true,max_shift_minutes:600,min_shift_enabled:true,min_shift_minutes:180,
 min_rest_enabled:true,min_rest_minutes:600,coverage_enabled:true,min_headcount:2
} as const;
const shape={
 meal_break_enabled:z.boolean(),meal_break_minutes:z.number().int().min(0).max(240),
 meal_break_after_minutes:z.number().int().min(0).max(1440),
 rest_break_enabled:z.boolean(),rest_break_minutes:z.number().int().min(0).max(60),
 rest_break_every_minutes:z.number().int().min(60).max(1440),
 weekly_ot_enabled:z.boolean(),weekly_ot_after_minutes:z.number().int().min(0).max(10080),
 ot_multiplier_bp:z.number().int().min(10000).max(50000),
 daily_ot_enabled:z.boolean(),daily_ot_after_minutes:z.number().int().min(0).max(1440),
 max_shift_enabled:z.boolean(),max_shift_minutes:z.number().int().min(30).max(1440),
 min_shift_enabled:z.boolean(),min_shift_minutes:z.number().int().min(0).max(1440),
 min_rest_enabled:z.boolean(),min_rest_minutes:z.number().int().min(0).max(1440),
 coverage_enabled:z.boolean(),min_headcount:z.number().int().min(1).max(30),
};
const teamRulePatch=z.strictObject(Object.fromEntries(Object.entries(shape).map(([k,v])=>[k,v.optional()])) as {[K in keyof typeof shape]:z.ZodOptional<(typeof shape)[K]>});
const ruleKeys=Object.keys(shape) as (keyof typeof shape)[];
export async function getTeamRules(){
 const owner=await requireSchedulingOwner();
 if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.from("team_rules").select("*").eq("business_id",owner.businessId).maybeSingle();
 if(error)return {ok:false as const,error:"storage_unavailable"};
 const {data:custom,error:customError}=await owner.supabase.from("staff_custom_rules")
   .select("id,rule_text,active").eq("business_id",owner.businessId).eq("active",true).order("created_at");
 if(customError)return {ok:false as const,error:"storage_unavailable"};
 return {ok:true as const,data:{...DEFAULT_TEAM_RULES,...data,
   owner_set:(data?.owner_set as string[]|undefined)??[],
   custom:custom??[]}};
}
export async function updateTeamRules(raw:unknown){
 const parsed=teamRulePatch.safeParse(raw);
 if(!parsed.success||!Object.keys(parsed.data).length)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const before=await getTeamRules();if(!before.ok)return before;
 const changes=Object.keys(parsed.data).filter(k=>ruleKeys.includes(k as keyof typeof shape));
 const ownerSet=[...new Set([...before.data.owner_set,...changes])];
 const {error}=await owner.supabase.from("team_rules").upsert({
   business_id:owner.businessId,...parsed.data,owner_set:ownerSet,updated_at:new Date().toISOString()
 },{onConflict:"business_id"});
 if(error)return {ok:false as const,error:"storage_unavailable"};
 revalidatePath("/staff/rules");revalidatePath("/staff");return {ok:true as const};
}
export async function addCustomRule(raw:unknown){
 const parsed=z.strictObject({text:z.string().trim().min(1).max(500)}).safeParse(raw);
 if(!parsed.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {error}=await owner.supabase.from("staff_custom_rules").insert({
   business_id:owner.businessId,rule_text:parsed.data.text});
 if(error)return {ok:false as const,error:"storage_unavailable"};
 revalidatePath("/staff/rules");return {ok:true as const};
}
export async function removeCustomRule(raw:unknown){
 const parsed=z.strictObject({id:z.string().uuid()}).safeParse(raw);
 if(!parsed.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {error}=await owner.supabase.from("staff_custom_rules").update({active:false})
  .eq("business_id",owner.businessId).eq("id",parsed.data.id);
 if(error)return {ok:false as const,error:"storage_unavailable"};
 revalidatePath("/staff/rules");return {ok:true as const};
}
