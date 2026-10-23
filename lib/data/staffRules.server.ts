import "server-only";
import {z} from "zod";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
import {staffReadScope} from "@/lib/scheduling/staffScope.server";
import {DEFAULT_TEAM_RULES} from "@/lib/calc/scheduling/teamRuleDefaults";
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
 prep_minutes_before_open:z.number().int().min(0).max(240),
 prep_minutes_after_close:z.number().int().min(0).max(240),
};
const teamRulePatch=z.strictObject(Object.fromEntries(Object.entries(shape).map(([k,v])=>[k,v.optional()])) as {[K in keyof typeof shape]:z.ZodOptional<(typeof shape)[K]>});
const ruleKeys=Object.keys(shape) as (keyof typeof shape)[];
export async function getTeamRules(){
 const owner=await staffReadScope();
 if(!owner.ok)return {ok:false as const,error:"unauthorized"};
 if(!owner.supabase)return {ok:true as const,data:{...DEFAULT_TEAM_RULES,owner_set:[],custom:[]},readOnly:true};
 const {data,error}=await owner.supabase.from("team_rules").select("*").eq("business_id",owner.businessId).maybeSingle();
 if(error)return {ok:false as const,error:"storage_unavailable"};
 const {data:custom,error:customError}=await owner.supabase.from("staff_custom_rules")
   .select("id,rule_text,active").eq("business_id",owner.businessId).eq("active",true).order("created_at");
 if(customError)return {ok:false as const,error:"storage_unavailable"};
 return {ok:true as const,data:{...DEFAULT_TEAM_RULES,...data,
   owner_set:(data?.owner_set as string[]|undefined)??[],
   custom:custom??[]},readOnly:owner.readOnly};
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
 return {ok:true as const};
}
export async function addCustomRule(raw:unknown){
 const parsed=z.strictObject({text:z.string().trim().min(1).max(500)}).safeParse(raw);
 if(!parsed.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.from("staff_custom_rules").insert({
   business_id:owner.businessId,rule_text:parsed.data.text}).select("id,rule_text").single();
 if(error||!data)return {ok:false as const,error:"storage_unavailable"};
 return {ok:true as const,data};
}
export async function removeCustomRule(raw:unknown){
 const parsed=z.strictObject({id:z.string().uuid()}).safeParse(raw);
 if(!parsed.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {error}=await owner.supabase.from("staff_custom_rules").update({active:false})
  .eq("business_id",owner.businessId).eq("id",parsed.data.id);
 if(error)return {ok:false as const,error:"storage_unavailable"};
 return {ok:true as const};
}
