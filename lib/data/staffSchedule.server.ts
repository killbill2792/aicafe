import "server-only";
import {formatInTimeZone} from "date-fns-tz";
import {reconcileStaffCalendar,type CalendarEntry} from "@/lib/calc/scheduling/calendarEntries";
import type {SupabaseClient} from "@supabase/supabase-js";
import {timeReader} from "@/lib/perf/timeReader.server";
import {readToastPlannedShifts} from "./toastScheduledShifts.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
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
export async function getWeekSchedule(raw:unknown, explicit?:{client:SupabaseClient;businessId:string;ownerUserId:string}){
 const p=weekInput.safeParse(raw);if(!p.success||!monday(p.data.weekStart))return {ok:false as const,error:"invalid_week"};
 const owner=await staffReadScope(explicit);if(!owner.ok)return {ok:false as const,error:"unauthorized"};
 const dates=Array.from({length:7},(_,i)=>plusDays(p.data.weekStart,i));
 if(!owner.supabase||owner.businessId===DEMO_BUSINESS_ID)return {ok:true as const,data:{
  dates,weekStart:p.data.weekStart,team:[],displayTeam:[],shifts:[],posShifts:[],calendarEntries:[] as CalendarEntry[],calendarWarnings:[] as string[],total:{paidMinutes:0,knownCostCents:0,estimateCount:0,unknownCount:0,estimated:false},
  gaps:[],adjacentShifts:[],posScheduleError:null,openHours:null,currency:owner.currency,rules:{...DEFAULT_TEAM_RULES,owner_set:[],custom:[]},availability:[],profileAvailability:[],readOnly:true,timezone:owner.timezone,countryCode:null as string|null
 }};
 // Start the optional external planned-shift read alongside the independent
 // roster queries. It stays read-only and never becomes a paid/approved shift.
 // Catch its own failure so the existing internal schedule still renders.
 const external=timeReader("Staff","getWeekSchedule.external",async()=>{
  try{
   return {posShifts:await readToastPlannedShifts(createAdminSupabaseClient(),
    owner.businessId,dates[0],dates[6],owner.timezone),posScheduleError:null as string|null};
  }catch(error){
   return {posShifts:[] as Awaited<ReturnType<typeof readToastPlannedShifts>>,
    posScheduleError:error instanceof Error?error.message:
     (error&&typeof error==="object"&&"message" in error?String(error.message):"unavailable")};
  }
 });
 const [people,shifts,profile,ruleResult,availability,profileAvailability]=await timeReader("Staff","getWeekSchedule.records",()=>Promise.all([
  owner.supabase.from("employees").select("id,display_name,role,active,default_hourly_wage_cents,wage_amount_cents,wage_period,available_days,min_weekly_minutes,max_weekly_minutes,phone_e164,whatsapp_opt_in,preferred_language,color_index")
    .eq("business_id",owner.businessId).order("display_name"),
  owner.supabase.from("scheduled_shifts").select("*").eq("business_id",owner.businessId)
    .gte("local_date",plusDays(dates[0],-1)).lte("local_date",plusDays(dates[6],1)).is("deleted_at",null).order("start_local"),
  owner.supabase.from("locations").select("open_hours,country_code").eq("business_id",owner.businessId)
   .order("name").limit(1).maybeSingle(),getTeamRules(explicit),
  owner.supabase.from("staff_availability_rules").select("employee_id,day_of_week,start_local,end_local,effective_from,effective_to")
   .eq("business_id",owner.businessId).lte("effective_from",dates[6]),
  owner.supabase.from("staff_availability_rules").select("employee_id,day_of_week,start_local,end_local,effective_from,effective_to")
   .eq("business_id",owner.businessId).lte("effective_from",owner.today)
   .or(`effective_to.is.null,effective_to.gte.${owner.today}`)
 ]));
 if(people.error||shifts.error||profile.error||availability.error||profileAvailability.error||!ruleResult.ok)return {ok:false as const,error:"storage_unavailable"};
 const {posShifts,posScheduleError}=await external;
 const allEmployees=(people.data??[]).map(p=>({active:p.active as boolean,
   id:p.id as string,name:p.display_name as string,role:p.role as string|null,
   wageCents: p.wage_period==="hour" ? ((p.wage_amount_cents as number|null)??(p.default_hourly_wage_cents as number|null))
    : p.default_hourly_wage_cents as number|null,
   minWeeklyMinutes:p.min_weekly_minutes as number|null,maxWeeklyMinutes:p.max_weekly_minutes as number|null,
   availableDays:p.available_days as number[]|null,colorIndex:p.color_index as number|null,
   phone:p.phone_e164 as string|null,whatsappOptIn:p.whatsapp_opt_in===true,
    preferredLanguage:p.preferred_language as "en"|"es"|"ar"|null,wagePeriod:p.wage_period as "hour"|"month"|"year",
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
 // Preserve POS evidence as evidence, not paid schedule estimates. The calendar
 // uses the SAME authorized owner scope as the existing staff reader.
 const calendarWarnings:string[]=[];
 const supervisorOliviaDates=new Set(mapped.filter(s=>s.source==="olivia"&&s.status==="draft")
   .map(s=>s.date));
 const entries:CalendarEntry[]=posShifts.flatMap(s=>{
  const first=new Date(s.start),last=new Date(s.end);
  if(!Number.isFinite(first.getTime())||!Number.isFinite(last.getTime())){
   calendarWarnings.push("toastPlannedIncomplete");
   return [];
  }
  return [{
   id:"toast-planned:"+s.locationId+":"+s.id,employeeId:s.employeeId,employeeName:s.employeeName,locationId:s.locationId,
   date:formatInTimeZone(first,owner.timezone,"yyyy-MM-dd"),
   endDate:formatInTimeZone(last,owner.timezone,"yyyy-MM-dd"),
   start:formatInTimeZone(first,owner.timezone,"HH:mm"),
   end:formatInTimeZone(last,owner.timezone,"HH:mm"),
   source:"toast_planned" as const
  }];
 });
 for(const shift of mapped.filter(s=>s.source==="olivia"&&s.status==="draft"&&
    s.date>=dates[0]&&s.date<=dates[6])){
  entries.push({id:"ai-supervisor:"+shift.id,employeeId:shift.employeeId,
   employeeName:shift.employeeName,date:shift.date,start:shift.start,end:shift.end,
   source:"ai_draft"});
 }
 try {
  const begin=new Date(Date.parse(dates[0]+"T00:00:00Z")-2*86400000).toISOString();
  const finish=new Date(Date.parse(dates[6]+"T00:00:00Z")+3*86400000).toISOString();
  const actual=await owner.supabase.from("timecards")
   .select("id,employee_id,clock_in,clock_out,source_provider")
   .eq("business_id",owner.businessId).eq("source_provider","Toast")
   .gte("clock_in",begin).lte("clock_in",finish).order("clock_in").limit(1001);
  if(actual.error||!actual.data||actual.data.length>1000)throw new Error("Toast clock-ins unavailable");
  for(const row of actual.data){
   if(typeof row.clock_in!=="string")continue;
   const date=formatInTimeZone(new Date(row.clock_in),owner.timezone,"yyyy-MM-dd");
   if(date<dates[0]||date>dates[6])continue;
   const person=allEmployees.find(p=>p.id===row.employee_id);
   entries.push({id:"toast-actual:"+row.id,employeeId:row.employee_id,
    employeeName:person?.name??"Toast team member",date,
    endDate:row.clock_out?formatInTimeZone(new Date(row.clock_out),owner.timezone,"yyyy-MM-dd"):date,
    start:formatInTimeZone(new Date(row.clock_in),owner.timezone,"HH:mm"),
    end:row.clock_out?formatInTimeZone(new Date(row.clock_out),owner.timezone,"HH:mm"):"…",
    source:"toast_actual"});
  }
 }catch{calendarWarnings.push("toastActualUnavailable");}
 if(process.env.SCHEDULING_FOUNDATION_ENABLED==="true"&&
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED==="true"){
  try {
   const series=await owner.supabase.from("scheduling_plan_series")
    .select("id,current_revision").eq("business_id",owner.businessId)
    .eq("horizon_start",p.data.weekStart).maybeSingle();
   if(series.error)throw series.error;
   if(series.data?.current_revision){
    const revision=await owner.supabase.from("scheduling_plan_revisions")
     .select("id,status,scenario").eq("business_id",owner.businessId)
     .eq("series_id",series.data.id).eq("revision",series.data.current_revision).maybeSingle();
    if(revision.error)throw revision.error;
    if(revision.data&&["draft","approved"].includes(revision.data.status)){
     const plan=revision.data.scenario as {shifts?:Array<{employeeId:string;startAt:string;endAt:string}>}|null;
     for(const [i,shift] of (plan?.shifts??[]).entries()){
      const date=formatInTimeZone(new Date(shift.startAt),owner.timezone,"yyyy-MM-dd");
      if(date<dates[0]||date>dates[6]||supervisorOliviaDates.has(date))continue;
      entries.push({id:"ai-draft:"+revision.data.id+":"+i,employeeId:shift.employeeId,
       employeeName:allEmployees.find(e=>e.id===shift.employeeId)?.name??"Team member",
       date,start:formatInTimeZone(new Date(shift.startAt),owner.timezone,"HH:mm"),
       end:formatInTimeZone(new Date(shift.endAt),owner.timezone,"HH:mm"),
       source:"ai_draft"});
     }
    }
   }
  }catch{calendarWarnings.push("oliviaDraftUnavailable");}
 }else calendarWarnings.push("oliviaDraftsDisabled");
 const calendarEntries=reconcileStaffCalendar(entries);
 const inWeek=mapped.filter(s=>s.date>=dates[0]&&s.date<=dates[6]);
 const displayTeam=peopleWithRetainedShifts(allEmployees,inWeek);
 const total=aggregateCosts(inWeek),gaps=coverageGaps(dates,mapped,openHours,
   ruleResult.data.coverage_enabled?ruleResult.data.min_headcount:0);
 return {ok:true as const,data:{
   dates,team,displayTeam,shifts:inWeek,posShifts,calendarEntries,calendarWarnings,posScheduleError,adjacentShifts:mapped.filter(s=>s.date<dates[0]||s.date>dates[6]),total,gaps,openHours,
   currency:owner.currency,rules:ruleResult.data,
   availability:availability.data??[],profileAvailability:profileAvailability.data??[],weekStart:p.data.weekStart,readOnly:owner.readOnly,timezone:owner.timezone,countryCode:profile.data?.country_code??null
 }};
}
export async function getCoverageGaps(raw:unknown){
 const result=await getWeekSchedule(raw);
 return result.ok?{ok:true as const,data:{gaps:result.data.gaps,weekStart:result.data.weekStart}}:result;
}
export async function getTeam(raw:unknown){
 const result=await getWeekSchedule(raw);
 return result.ok?{ok:true as const,data:{team:result.data.team,shifts:result.data.shifts,
   posShifts:result.data.posShifts,posScheduleError:result.data.posScheduleError,timezone:result.data.timezone,
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
