import "server-only";
import {prepareScheduleCopy} from "@/lib/calc/scheduling/scheduleMessages";
import {peopleWithRetainedShifts} from "@/lib/calc/scheduling/schedulePresentation";
import {z} from "zod";
import {shiftInput,restoreShiftInput} from "@/lib/calc/scheduling/scheduleValidators";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
import {normalizeOpenHours} from "@/lib/business/openHours";
import {staffReadScope} from "@/lib/scheduling/staffScope.server";
import {DEFAULT_TEAM_RULES} from "@/lib/calc/scheduling/teamRuleDefaults";
import {DEMO_BUSINESS_ID} from "@/lib/constants";
import {getTeamRules} from "./staffRules.server";
import {coverageGaps} from "@/lib/calc/scheduling/coverageGaps";
import {automaticUnpaidBreakMinutes} from "@/lib/calc/scheduling/ruleChecks";
import {shiftCost,roleWageAverages,businessWageEstimate,aggregateCosts,elapsedMinutes,type CostShift} from "@/lib/calc/scheduling/shiftCost";
const iso=z.iso.date(),hhmm=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const weekInput=z.strictObject({weekStart:iso});

const monday=(date:string)=>{const d=new Date(date+"T12:00:00Z");return d.getUTCDay()===1;};
const plusDays=(date:string,n:number)=>new Date(Date.parse(date+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);
export async function getWeekSchedule(raw:unknown){
 const p=weekInput.safeParse(raw);if(!p.success||!monday(p.data.weekStart))return {ok:false as const,error:"invalid_week"};
 const owner=await staffReadScope();if(!owner.ok)return {ok:false as const,error:"unauthorized"};
 const dates=Array.from({length:7},(_,i)=>plusDays(p.data.weekStart,i));
 if(!owner.supabase||owner.businessId===DEMO_BUSINESS_ID)return {ok:true as const,data:{
  dates,weekStart:p.data.weekStart,team:[],displayTeam:[],shifts:[],total:{paidMinutes:0,knownCostCents:0,estimateCount:0,unknownCount:0,estimated:false},
  gaps:[],adjacentShifts:[],openHours:null,currency:owner.currency,rules:{...DEFAULT_TEAM_RULES,owner_set:[],custom:[]},availability:[],profileAvailability:[],readOnly:true,timezone:owner.timezone
 }};
 const [people,shifts,profile,ruleResult,availability,profileAvailability]=await Promise.all([
  owner.supabase.from("employees").select("id,display_name,role,active,default_hourly_wage_cents,wage_amount_cents,wage_period,available_days,min_weekly_minutes,max_weekly_minutes,phone_e164,color_index")
    .eq("business_id",owner.businessId).order("display_name"),
  owner.supabase.from("scheduled_shifts").select("*").eq("business_id",owner.businessId)
    .gte("local_date",plusDays(dates[0],-1)).lte("local_date",plusDays(dates[6],1)).is("deleted_at",null).order("start_local"),
  owner.supabase.from("locations").select("open_hours").eq("business_id",owner.businessId)
   .order("name").limit(1).maybeSingle(),getTeamRules(),
  owner.supabase.from("staff_availability_rules").select("employee_id,day_of_week,start_local,end_local,effective_from,effective_to")
   .eq("business_id",owner.businessId).lte("effective_from",dates[6]),
  owner.supabase.from("staff_availability_rules").select("employee_id,day_of_week,start_local,end_local,effective_from,effective_to")
   .eq("business_id",owner.businessId).lte("effective_from",owner.today)
   .or(`effective_to.is.null,effective_to.gte.${owner.today}`)
 ]);
 if(people.error||shifts.error||profile.error||availability.error||profileAvailability.error||!ruleResult.ok)return {ok:false as const,error:"storage_unavailable"};
 const allEmployees=(people.data??[]).map(p=>({active:p.active as boolean,
   id:p.id as string,name:p.display_name as string,role:p.role as string|null,
   wageCents: p.wage_period==="hour" ? ((p.wage_amount_cents as number|null)??(p.default_hourly_wage_cents as number|null))
    : p.default_hourly_wage_cents as number|null,
   minWeeklyMinutes:p.min_weekly_minutes as number|null,maxWeeklyMinutes:p.max_weekly_minutes as number|null,
   availableDays:p.available_days as number[]|null,colorIndex:p.color_index as number|null,
   phone:p.phone_e164 as string|null,wagePeriod:p.wage_period as "hour"|"month"|"year",
   salaryAmountCents:p.wage_period==="hour"?null:p.wage_amount_cents as number|null
 }));
 const team=allEmployees.filter(p=>p.active);
 const openHours=normalizeOpenHours(profile.data?.open_hours);
 // A retired person's retained shifts remain priced with their actual compensation.
 const averages=roleWageAverages(allEmployees),defaultWage=businessWageEstimate(allEmployees);
 const mapped=(shifts.data??[]).map(s=>{
   const person=allEmployees.find(p=>p.id===s.employee_id);
   const input:CostShift={employeeId:s.employee_id,date:s.local_date,start:String(s.start_local).slice(0,5),
      end:String(s.end_local).slice(0,5),overnight:s.overnight,
      breakMinutes:s.break_minutes,wageCents:person?.wageCents??null,role:person?.role};
   return {...shiftCost(input,person?.role?averages.get(person.role.toLowerCase())??null:null,defaultWage),
     id:s.id as string,status:s.status as string,source:s.source as string,breakSource:s.break_source as string,
     employeeName:person?.name??"Unknown"};
 });
 const inWeek=mapped.filter(s=>s.date>=dates[0]&&s.date<=dates[6]);
 const displayTeam=peopleWithRetainedShifts(allEmployees,inWeek);
 const total=aggregateCosts(inWeek),gaps=coverageGaps(dates,mapped,openHours,
   ruleResult.data.coverage_enabled?ruleResult.data.min_headcount:0);
 return {ok:true as const,data:{
   dates,team,displayTeam,shifts:inWeek,adjacentShifts:mapped.filter(s=>s.date<dates[0]||s.date>dates[6]),total,gaps,openHours,
   currency:owner.currency,rules:ruleResult.data,
   availability:availability.data??[],profileAvailability:profileAvailability.data??[],weekStart:p.data.weekStart,readOnly:owner.readOnly,timezone:owner.timezone
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
 const roleAverage=roleWageAverages(schedule.data.team),defaultWage=businessWageEstimate(schedule.data.team);
 const breakMinutes=p.data.breakMinutes??automaticUnpaidBreakMinutes(
   p.data.start,p.data.end,schedule.data.rules);
 return {ok:true as const,data:shiftCost({
   employeeId:p.data.employeeId,date:p.data.date,start:p.data.start,end:p.data.end,
   overnight:p.data.end<p.data.start,breakMinutes,wageCents:person.wageCents,role:person.role
 },person.role?roleAverage.get(person.role.toLowerCase())??null:null,defaultWage)};
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
 const breakMinutes=p.data.breakMinutes??automaticUnpaidBreakMinutes(p.data.start,p.data.end,rules.data);
 if(breakMinutes>=length)return {ok:false as const,error:"invalid_break"};
 const row={business_id:owner.businessId,employee_id:p.data.employeeId,local_date:p.data.date,
   start_local:p.data.start,end_local:p.data.end,overnight,break_minutes:breakMinutes,
   break_source:p.data.breakMinutes==null?"rule":"owner",status:"draft",source:"owner"};
 // The dated roster and legacy payroll schedule are separate systems.
 // Materialize a clearly bounded year of weekly dated shifts atomically instead
 // of inserting null-wage payroll templates that would poison timecard creation.
 if(p.data.repeatWeekly&&p.data.id)return {ok:false as const,error:"repeat_requires_new_shift"};
 if(p.data.repeatWeekly){
  const weekly=Array.from({length:52},(_,n)=>({...row,
   local_date:plusDays(p.data.date,n*7),source:n===0?"owner":"repeat"}));
  const saved=await owner.supabase.from("scheduled_shifts").insert(weekly).select("id");
  if(saved.error||!saved.data?.length)return {ok:false as const,error:"storage_unavailable"};
  return {ok:true as const,id:saved.data[0].id as string};
 }
 const query=p.data.id?owner.supabase.from("scheduled_shifts").update(row).eq("id",p.data.id)
   .eq("business_id",owner.businessId).is("deleted_at",null).select("id").maybeSingle()
  :owner.supabase.from("scheduled_shifts").insert(row).select("id").single();
 const saved=await query;if(saved.error||!saved.data)return {ok:false as const,error:"storage_unavailable"};
 return {ok:true as const,id:saved.data.id as string};
}
export async function removeShift(raw:unknown){
 const p=z.strictObject({id:z.string().uuid()}).safeParse(raw);if(!p.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.from("scheduled_shifts").update({deleted_at:new Date().toISOString()})
  .eq("business_id",owner.businessId).eq("id",p.data.id).is("deleted_at",null).select("id").maybeSingle();
 if(error||!data)return {ok:false as const,error:"not_found"};
 return {ok:true as const,id:data.id as string};
}
export async function restoreShift(raw:unknown){
 const parsed=restoreShiftInput.safeParse(raw);
 if(!parsed.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.from("scheduled_shifts").update({deleted_at:null})
  .eq("business_id",owner.businessId).eq("id",parsed.data.id)
  .not("deleted_at","is",null).select("id").maybeSingle();
 if(error||!data)return {ok:false as const,error:"not_found"};
 return {ok:true as const,id:data.id as string};
}
export async function copyWeek(raw:unknown){
 const p=z.strictObject({fromWeekStart:iso,toWeekStart:iso}).safeParse(raw);
 if(!p.success||!monday(p.data.fromWeekStart)||!monday(p.data.toWeekStart)||p.data.fromWeekStart===p.data.toWeekStart)
 return {ok:false as const,error:"invalid_week"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const source=await owner.supabase.from("scheduled_shifts").select("*") .eq("business_id",owner.businessId)
  .is("deleted_at",null).gte("local_date",p.data.fromWeekStart).lte("local_date",plusDays(p.data.fromWeekStart,6));
 if(source.error)return {ok:false as const,error:"storage_unavailable"};
 const existing=await owner.supabase.from("scheduled_shifts").select("id") .eq("business_id",owner.businessId)
  .is("deleted_at",null).gte("local_date",p.data.toWeekStart).lte("local_date",plusDays(p.data.toWeekStart,6)).limit(1);
 if(existing.error||existing.data?.length)return {ok:false as const,error:"target_week_not_empty"};
 const shiftDays=Math.round((Date.parse(p.data.toWeekStart)-Date.parse(p.data.fromWeekStart))/86400000);
 if(!source.data?.length)return {ok:true as const,count:0};
 const rows=source.data.map(s=>({business_id:owner.businessId,employee_id:s.employee_id,
   local_date:plusDays(s.local_date,shiftDays),start_local:s.start_local,end_local:s.end_local,
   overnight:s.overnight,break_minutes:s.break_minutes,break_source:s.break_source,
   role:s.role,status:"draft",source:"copied"}));
 const {error}=await owner.supabase.from("scheduled_shifts").insert(rows);
 if(error)return {ok:false as const,error:"storage_unavailable"};
 return {ok:true as const,count:rows.length};
}
export async function sendSchedule(raw:unknown){
 const p=weekInput.safeParse(raw);if(!p.success||!monday(p.data.weekStart))return {ok:false as const,error:"invalid_week"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const schedule=await getWeekSchedule(p.data);if(!schedule.ok)return schedule;
 const messages=prepareScheduleCopy(schedule.data.team,schedule.data.shifts);
 // Generating copy-ready messages is NOT delivery. Never claim a sent schedule
 // or mutate a shift until an actual staff delivery channel confirms it.
 // WhatsApp transport is intentionally not connected: owner gets copy-ready text instead.
 return {ok:true as const,data:{messages,channel:"copy" as const,sent:false as const}};
}
