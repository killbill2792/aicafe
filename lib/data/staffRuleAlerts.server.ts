import "server-only";
import {fromZonedTime} from "date-fns-tz";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
import {staffReadScope,mondayOfLocalDate} from "@/lib/scheduling/staffScope.server";
import {getTeamRules} from "@/lib/data/staffRules.server";
import {checkTimecardRules,type RuleSettings,type TimecardForRules} from "@/lib/calc/scheduling/ruleChecks";
import {dedupeAlerts} from "@/lib/calc/scheduling/ruleAlerts";

const inPast=(date:string,days:number)=>new Date(Date.parse(date+"T12:00:00Z")-days*86400000).toISOString().slice(0,10);
function parseBreaks(value:unknown):TimecardForRules["breaks"] {
 if(!Array.isArray(value))return [];
 return value.filter((b):b is {start:string;end:string;paid:boolean}=>
  typeof b==="object"&&b!==null&&typeof b.start==="string"&&
  typeof b.end==="string"&&typeof b.paid==="boolean");
}
/** Refresh read-only owner alerts from recorded facts. A unique constraint and
 * ignoreDuplicates preserve previous dismissals, including concurrent refreshes. */
export async function syncStaffRuleAlerts(){
 const owner=await requireSchedulingOwner();
 if(!owner)return {ok:true as const,alerts:[],readOnly:true};
 const scope=await staffReadScope();
 if(!scope.ok||!scope.supabase)return {ok:false as const,error:"unauthorized"};
 const rules=await getTeamRules();
 if(!rules.ok)return {ok:false as const,error:"rules_unavailable"};
 const first=mondayOfLocalDate(inPast(scope.today,14));
 const startUtc=fromZonedTime(first+"T00:00:00",scope.timezone).toISOString();
 const recent=await owner.supabase.from("timecards")
  .select("id,employee_id,clock_in,clock_out,breaks,source_type",{count:"exact"})
  .eq("business_id",owner.businessId).gte("clock_in",startUtc)
  .order("clock_in",{ascending:true}).limit(1500);
 if(recent.error||recent.count===null||recent.count>1500)return {ok:false as const,error:"timecards_unavailable"};
 const actual=(recent.data??[]).filter(row=>row.employee_id&&row.clock_out&&
   row.source_type!=="owner_schedule").map(row=>({
    id:row.id as string,employeeId:row.employee_id as string,start:row.clock_in as string,
    end:row.clock_out as string,breaks:parseBreaks(row.breaks)
   }));
 const violations=dedupeAlerts(checkTimecardRules(actual,rules.data as unknown as RuleSettings,scope.timezone));
 if(violations.length){
  const rows=violations.map(v=>({business_id:owner.businessId,timecard_id:v.timecardId,
   employee_id:v.employeeId,rule_key:v.key,message:v.details,status:"new",
   staff_notification_status:"not_requested"}));
  const insert=await owner.supabase.from("staff_rule_alerts")
   .upsert(rows,{onConflict:"business_id,timecard_id,rule_key",ignoreDuplicates:true});
  if(insert.error)return {ok:false as const,error:"alert_storage_unavailable"};
 }
 const result=await owner.supabase.from("staff_rule_alerts")
  .select("id,employee_id,rule_key,message,created_at")
  .eq("business_id",owner.businessId).eq("status","new")
  .order("created_at",{ascending:false}).limit(40);
 if(result.error)return {ok:false as const,error:"alert_storage_unavailable"};
 return {ok:true as const,alerts:result.data??[],readOnly:false};
}
/** TODO W1: plug in worker-authenticated WhatsApp transport after recipient consent.
 * This function deliberately sends nothing and changes no delivery status. */
export async function notifyStaffOfRuleAlert(_alertId:string){
 return {queued:false as const,reason:"whatsapp_not_implemented" as const};
}
