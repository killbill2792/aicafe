import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {normalizeOpenHours} from "@/lib/business/openHours";
import type {SchedulingDraftInputs} from "@/lib/calc/scheduling/draftWeek";
import type {KnownSlice} from "@/lib/operating/types";

export async function readSchedulingDraftInputs(client:SupabaseClient,businessId:string):Promise<KnownSlice<SchedulingDraftInputs>> {
 const [employees,schedules,availability,preferences,locations,business,teamRules,exceptions]=await Promise.all([
  client.from("employees").select("id,display_name,default_hourly_wage_cents,wage_period,wage_amount_cents,available_days").eq("business_id",businessId).eq("active",true).limit(201),
  client.from("staff_schedules").select("employee_id,day_of_week,start_time,end_time,unpaid_break_minutes,effective_from,effective_to").eq("business_id",businessId).eq("active",true).limit(201),
  client.from("staff_availability_rules").select("employee_id,day_of_week,start_local,end_local,confirmation,source,effective_from,effective_to").eq("business_id",businessId).limit(201),
  client.from("staff_scheduling_preferences").select("employee_id,max_weekly_minutes,effective_from,effective_to").eq("business_id",businessId).limit(201),
  client.from("locations").select("open_hours,timezone,city,region,country_code").eq("business_id",businessId).order("name").limit(1),
  client.from("businesses").select("timezone").eq("id",businessId).single(),
  client.from("team_rules").select("prep_minutes_before_open,prep_minutes_after_close").eq("business_id",businessId).maybeSingle(),
  client.from("staff_availability_exceptions").select("employee_id,local_date,exception_type,start_local,end_local,overnight,confirmation").eq("business_id",businessId).eq("confirmation","owner_confirmed").limit(201)
 ]);
 for(const result of [employees,schedules,availability,preferences,locations,business,teamRules,exceptions])if(result.error)throw result.error;
 const missing:string[]=[];
 if([employees,schedules,availability,preferences,exceptions].some(r=>(r.data??[]).length>200))missing.push("scheduleInputsTruncated");
 const location=locations.data?.[0],openHours=normalizeOpenHours(location?.open_hours);
 if(!openHours)missing.push("businessHoursNotSet");
 const value:SchedulingDraftInputs={
  employees:(employees.data??[]).slice(0,200).map(x=>({...x,default_hourly_wage_cents:x.default_hourly_wage_cents==null?null:Number(x.default_hourly_wage_cents),wage_amount_cents:x.wage_amount_cents==null?null:Number(x.wage_amount_cents)})),
  schedules:(schedules.data??[]).slice(0,200).map(x=>({...x,start_time:String(x.start_time).slice(0,5),end_time:String(x.end_time).slice(0,5)})),
  availability:(availability.data??[]).slice(0,200).map(x=>({...x,start_local:String(x.start_local).slice(0,5),end_local:String(x.end_local).slice(0,5)})),
  preferences:(preferences.data??[]).slice(0,200),
  openHours,prepMinutesBeforeOpen:teamRules.data?.prep_minutes_before_open??0,
  prepMinutesAfterClose:teamRules.data?.prep_minutes_after_close??0,
  unavailableDates:(exceptions.data??[]).filter(x=>["unavailable","approved_leave"].includes(x.exception_type)).map(x=>({employeeId:x.employee_id,date:x.local_date,
    start:x.start_local===null?null:String(x.start_local).slice(0,5),
    end:x.end_local===null?null:String(x.end_local).slice(0,5),
    overnight:x.overnight===true})),
  timezone:location?.timezone??business.data?.timezone??"UTC",
  timezoneDefaultedToUtc:!location?.timezone&&!business.data?.timezone,
  city:location?.city??null,region:location?.region??null,countryCode:location?.country_code??null
 };
 return {available:true,value,quality:{level:missing.length?"medium":"high",missingInputs:missing,estimatedInputs:[],staleInputs:[]}};
}
