"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
import {getCafeProfile} from "@/lib/data/getCafeProfile";
import {getTeamRules} from "./teamRules";
import {coverageGaps} from "@/lib/calc/scheduling/coverageGaps";
import {shiftCost,roleWageAverages,aggregateCosts,elapsedMinutes,type CostShift} from "@/lib/calc/scheduling/shiftCost";
const iso=z.iso.date(),hhmm=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const weekInput=z.strictObject({weekStart:iso});
const shiftInput=z.strictObject({
 id:z.string().uuid().optional(),employeeId:z.string().uuid(),date:iso,
 start:hhmm,end:hhmm,breakMinutes:z.number().int().min(0).max(240).optional(),
 repeatWeekly:z.boolean().optional()
});
const monday=(date:string)=>{const d=new Date(date+"T12:00:00Z");return d.getUTCDay()===1;};
const plusDays=(date:string,n:number)=>new Date(Date.parse(date+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);
export async function getWeekSchedule(raw:unknown){
 const p=weekInput.safeParse(raw);if(!p.success||!monday(p.data.weekStart))return {ok:false as const,error:"invalid_week"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const dates=Array.from({length:7},(_,i)=>plusDays(p.data.weekStart,i));
 const [people,shifts,profile,ruleResult,availability]=await Promise.all([
  owner.supabase.from("employees").select("id,display_name,role,active,default_hourly_wage_cents,wage_amount_cents,wage_period,available_days,min_weekly_minutes,max_weekly_minutes,phone_e164,color_index")
    .eq("business_id",owner.businessId).eq("active",true).order("display_name"),
  owner.supabase.from("scheduled_shifts").select("*").eq("business_id",owner.businessId)
    .gte("local_date",dates[0]).lte("local_date",dates[6]).order("start_local"),
  getCafeProfile(),getTeamRules(),
  owner.supabase.from("staff_availability_rules").select("employee_id,day_of_week,start_local,end_local,effective_from,effective_to")
   .eq("business_id",owner.businessId).lte("effective_from",dates[6])
 ]);
 if(people.error||shifts.error||availability.error||!ruleResult.ok)return {ok:false as const,error:"storage_unavailable"};
 const team=(people.data??[]).map(p=>({
   id:p.id as string,name:p.display_name as string,role:p.role as string|null,
   wageCents: p.wage_period==="hour" ? ((p.wage_amount_cents as number|null)??(p.default_hourly_wage_cents as number|null))
    : p.default_hourly_wage_cents as number|null,
   minWeeklyMinutes:p.min_weekly_minutes as number|null,maxWeeklyMinutes:p.max_weekly_minutes as number|null,
   availableDays:p.available_days as number[]|null,colorIndex:p.color_index as number|null,
   phone:p.phone_e164 as string|null
 }));
 const averages=roleWageAverages(team);
 const mapped=(shifts.data??[]).map(s=>{
   const person=team.find(p=>p.id===s.employee_id);
   const input:CostShift={employeeId:s.employee_id,date:s.local_date,start:String(s.start_local).slice(0,5),
      end:String(s.end_local).slice(0,5),overnight:s.overnight,
      breakMinutes:s.break_minutes,wageCents:person?.wageCents??null,role:person?.role};
   return {...shiftCost(input,person?.role?averages.get(person.role.toLowerCase())??null:null),
     id:s.id as string,status:s.status as string,source:s.source as string,breakSource:s.break_source as string,
     employeeName:person?.name??"Unknown"};
 });
 const total=aggregateCosts(mapped),gaps=coverageGaps(dates,mapped,profile.openHours,
   ruleResult.data.coverage_enabled?ruleResult.data.min_headcount:0);
 return {ok:true as const,data:{
   dates,team,shifts:mapped,total,gaps,openHours:profile.openHours,
   currency:profile.currency,rules:ruleResult.data,
   availability:availability.data??[],weekStart:p.data.weekStart
 }};
}
export async function getCoverageGaps(raw:unknown){
 const result=await getWeekSchedule(raw);
 return result.ok?{ok:true as const,data:{gaps:result.data.gaps,weekStart:result.data.weekStart}}:result;
}
export async function getTeam(raw:unknown){
 const result=await getWeekSchedule(raw);
 return result.ok?{ok:true as const,data:{team:result.data.team,shifts:result.data.shifts,
   totals:result.data.total}}:result;
}
export async function getShiftCost(raw:unknown){
 const p=shiftInput.safeParse(raw);if(!p.success)return {ok:false as const,error:"invalid_input"};
 const ws=plusDays(p.data.date,-((new Date(p.data.date+"T12:00:00Z").getUTCDay()+6)%7));
 const schedule=await getWeekSchedule({weekStart:ws});if(!schedule.ok)return schedule;
 const person=schedule.data.team.find(person=>person.id===p.data.employeeId);
 if(!person)return {ok:false as const,error:"unknown_employee"};
 const roleAverage=roleWageAverages(schedule.data.team);
 const breakMinutes=p.data.breakMinutes??(elapsedMinutes(p.data.start,p.data.end,p.data.end<p.data.start)>
   schedule.data.rules.meal_break_after_minutes&&schedule.data.rules.meal_break_enabled?
   schedule.data.rules.meal_break_minutes:0);
 return {ok:true as const,data:shiftCost({
   employeeId:p.data.employeeId,date:p.data.date,start:p.data.start,end:p.data.end,
   overnight:p.data.end<p.data.start,breakMinutes,wageCents:person.wageCents,role:person.role
 },person.role?roleAverage.get(person.role.toLowerCase())??null:null)};
}
export async function upsertShift(raw:unknown){
 const p=shiftInput.safeParse(raw);if(!p.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data:person}=await owner.supabase.from("employees").select("id").eq("business_id",owner.businessId)
   .eq("id",p.data.employeeId).eq("active",true).maybeSingle();
 if(!person)return {ok:false as const,error:"unknown_employee"};
 const rules=await getTeamRules();if(!rules.ok)return rules;
 const overnight=p.data.end<p.data.start;
 let length:number;try{length=elapsedMinutes(p.data.start,p.data.end,overnight);}catch{return {ok:false as const,error:"invalid_shift"};}
 const breakMinutes=p.data.breakMinutes??(rules.data.meal_break_enabled&&length>rules.data.meal_break_after_minutes?
   rules.data.meal_break_minutes:0);
 if(breakMinutes>=length)return {ok:false as const,error:"invalid_break"};
 const row={business_id:owner.businessId,employee_id:p.data.employeeId,local_date:p.data.date,
   start_local:p.data.start,end_local:p.data.end,overnight,break_minutes:breakMinutes,
   break_source:p.data.breakMinutes==null?"rule":"owner",status:"draft",source:"owner"};
 const query=p.data.id?owner.supabase.from("scheduled_shifts").update(row).eq("id",p.data.id)
  .eq("business_id",owner.businessId).select("id").maybeSingle()
  :owner.supabase.from("scheduled_shifts").insert(row).select("id").single();
 const saved=await query;if(saved.error||!saved.data)return {ok:false as const,error:"storage_unavailable"};
 if(p.data.repeatWeekly){
   // A recurring template is written separately; never creates payroll timecards.
   await owner.supabase.from("staff_schedules").insert({business_id:owner.businessId,employee_id:p.data.employeeId,
     day_of_week:new Date(p.data.date+"T12:00:00Z").getUTCDay(),start_time:p.data.start,
     end_time:p.data.end,unpaid_break_minutes:breakMinutes,hourly_wage_cents:null,effective_from:p.data.date,active:true});
 }
 revalidatePath("/staff");return {ok:true as const,id:saved.data.id as string};
}
export async function removeShift(raw:unknown){
 const p=z.strictObject({id:z.string().uuid()}).safeParse(raw);if(!p.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.from("scheduled_shifts").delete().eq("business_id",owner.businessId)
  .eq("id",p.data.id).select("*").maybeSingle();
 if(error||!data)return {ok:false as const,error:"not_found"};
 revalidatePath("/staff");return {ok:true as const,removed:data};
}
export async function restoreShift(raw:unknown){
 const p=z.strictObject({removed:z.record(z.string(),z.unknown())}).safeParse(raw);
 if(!p.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const row=p.data.removed;if(row.business_id!==owner.businessId)return {ok:false as const,error:"unauthorized"};
 const safe=shiftInput.safeParse({id:row.id,employeeId:row.employee_id,date:row.local_date,
  start:String(row.start_local).slice(0,5),end:String(row.end_local).slice(0,5),
  breakMinutes:row.break_minutes});
 if(!safe.success)return {ok:false as const,error:"invalid_input"};
 const {error}=await owner.supabase.from("scheduled_shifts").insert(row);
 if(error)return {ok:false as const,error:"storage_unavailable"};
 revalidatePath("/staff");return {ok:true as const};
}
export async function copyWeek(raw:unknown){
 const p=z.strictObject({fromWeekStart:iso,toWeekStart:iso}).safeParse(raw);
 if(!p.success||!monday(p.data.fromWeekStart)||!monday(p.data.toWeekStart)||p.data.fromWeekStart===p.data.toWeekStart)
 return {ok:false as const,error:"invalid_week"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const source=await owner.supabase.from("scheduled_shifts").select("*").eq("business_id",owner.businessId)
  .gte("local_date",p.data.fromWeekStart).lte("local_date",plusDays(p.data.fromWeekStart,6));
 if(source.error)return {ok:false as const,error:"storage_unavailable"};
 const existing=await owner.supabase.from("scheduled_shifts").select("id").eq("business_id",owner.businessId)
  .gte("local_date",p.data.toWeekStart).lte("local_date",plusDays(p.data.toWeekStart,6)).limit(1);
 if(existing.error||existing.data?.length)return {ok:false as const,error:"target_week_not_empty"};
 const shiftDays=Math.round((Date.parse(p.data.toWeekStart)-Date.parse(p.data.fromWeekStart))/86400000);
 if(!source.data?.length)return {ok:true as const,count:0};
 const rows=source.data.map(s=>({business_id:owner.businessId,employee_id:s.employee_id,
   local_date:plusDays(s.local_date,shiftDays),start_local:s.start_local,end_local:s.end_local,
   overnight:s.overnight,break_minutes:s.break_minutes,break_source:s.break_source,
   role:s.role,status:"draft",source:"copied"}));
 const {error}=await owner.supabase.from("scheduled_shifts").insert(rows);
 if(error)return {ok:false as const,error:"storage_unavailable"};
 revalidatePath("/staff");return {ok:true as const,count:rows.length};
}
export async function sendSchedule(raw:unknown){
 const p=weekInput.safeParse(raw);if(!p.success||!monday(p.data.weekStart))return {ok:false as const,error:"invalid_week"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const schedule=await getWeekSchedule(p.data);if(!schedule.ok)return schedule;
 const messages=schedule.data.team.map(person=>({
   name:person.name,phone:person.phone,text:person.name+" — "+schedule.data.shifts
    .filter(s=>s.employeeId===person.id).map(s=>s.date+" "+s.start+"–"+s.end).join("; ")
 })).filter(x=>x.text.endsWith(" — ")===false);
 const {error}=await owner.supabase.from("scheduled_shifts").update({status:"sent"})
  .eq("business_id",owner.businessId).gte("local_date",p.data.weekStart)
  .lte("local_date",plusDays(p.data.weekStart,6));
 if(error)return {ok:false as const,error:"storage_unavailable"};
 // WhatsApp transport is intentionally not connected: owner gets copy-ready text instead.
 revalidatePath("/staff");return {ok:true as const,data:{messages,channel:"copy" as const}};
}
