import "server-only";
import {z} from "zod";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
import {parseAvailabilityText} from "@/lib/calc/scheduling/parseAvailabilityText";
import {staffProposalInputs,type StaffProposalName} from "@/lib/ai/agent/tools/staffProposals";
import {registerLoopCapability,type OwnerLoopScope} from "./engine";

const names=Object.keys(staffProposalInputs) as StaffProposalName[];
export const staffCapabilityId=(name:StaffProposalName)=>"olivia.staff_"+name+".v1";
export const isStaffCapabilityId=(id:string)=>names.some(n=>staffCapabilityId(n)===id);
const line=z.strictObject({label:z.string().max(220),before:z.string().max(6000),after:z.string().max(6000)});
const effectSchema=z.strictObject({
 operation:z.enum(["propose_schedule","propose_shift_change","propose_add_staff",
  "propose_staff_change","propose_availability_change","propose_rule_change","propose_send_schedule"]),
 expectedToken:z.string().regex(/^[a-f0-9]{32}$/),
 preview:z.array(line).min(1).max(100),
 payload:z.record(z.string(),z.unknown()),
});
type Person={id:string;display_name:string;role:string|null;active:boolean;
 wage_period:string;wage_amount_cents:number|null;phone_e164:string|null;whatsapp_opt_in:boolean};
type Shift={id:string;employee_id:string;local_date:string;start_local:string;end_local:string;break_minutes:number;status:string;deleted_at:string|null};
const DAY=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const when=(x:{date:string;start:string;end:string})=>x.date+" "+x.start+"–"+x.end;
const isoDay=(d:string)=>new Date(d+"T12:00:00Z").getUTCDay();
const add=(d:string,n:number)=>new Date(Date.parse(d+"T12:00:00Z")+86400000*n).toISOString().slice(0,10);
const fmtShift=(s:Shift)=>when({date:s.local_date,start:s.start_local.slice(0,5),end:s.end_local.slice(0,5)});
const display=(v:unknown)=>v===null||v===undefined?"—":String(v);
function ensure(ok:unknown,msg:string):asserts ok{if(!ok)throw new Error(msg);}
async function readToken(scope:OwnerLoopScope){
 const {data,error}=await createAdminSupabaseClient().rpc("supervisor_staff_source_token",{p_business_id:scope.businessId});
 if(error||typeof data!=="string"||!/^[a-f0-9]{32}$/.test(data))throw new Error("Staff revision unavailable; apply migration 087");
 return data;
}
export {readToken as readStaffProposalToken};
async function prepare(scope:OwnerLoopScope,name:StaffProposalName,raw:unknown){
 const owner=await requireSchedulingOwner();
 if(!owner||owner.businessId!==scope.businessId)throw new Error("Only the current café owner can propose staff changes");
 const user=await owner.supabase.auth.getUser();
 if(user.error||user.data.user?.id!==scope.ownerUserId)throw new Error("Owner session changed");
 const input=staffProposalInputs[name].parse(raw);
 const beforeToken=await readToken(scope);
 const db=createAdminSupabaseClient();
 const [peopleResult,shiftsResult,rulesResult,availabilityResult,exceptionsResult,locationResult]=await Promise.all([
  db.from("employees").select("id,display_name,role,active,wage_period,wage_amount_cents,phone_e164,whatsapp_opt_in").eq("business_id",scope.businessId).limit(501),
  db.from("scheduled_shifts").select("id,employee_id,local_date,start_local,end_local,break_minutes,status,deleted_at").eq("business_id",scope.businessId).is("deleted_at",null).limit(501),
  db.from("team_rules").select("*").eq("business_id",scope.businessId).maybeSingle(),
  db.from("staff_availability_rules").select("employee_id,day_of_week,start_local,end_local,effective_from,effective_to,source").eq("business_id",scope.businessId).limit(501),
  db.from("staff_availability_exceptions").select("employee_id,local_date,exception_type").eq("business_id",scope.businessId).limit(501),
  db.from("locations").select("id").eq("business_id",scope.businessId).limit(501),
 ]);
 if([peopleResult,shiftsResult,rulesResult,availabilityResult,exceptionsResult,locationResult].some(r=>r.error))
  throw new Error("Staff preview unavailable");
 if([peopleResult,shiftsResult,availabilityResult,exceptionsResult,locationResult].some(r=>(r.data??[]).length>500))
  throw new Error("Too many staff records to preview safely");
 const people=(peopleResult.data??[]) as Person[],shifts=(shiftsResult.data??[]) as Shift[];
 const active=(id:string)=>{const p=people.find(p=>p.id===id&&p.active);ensure(p,"Active staff member not found");return p;};
 const preview:Array<{label:string;before:string;after:string}>=[];
 const shown=(id:string)=>people.find(p=>p.id===id)?.display_name??id;
 const item=(label:string,before:string,after:string)=>preview.push({label,before,after});
 let payload:Record<string,unknown>={};
 const cafeZone=await owner.supabase.from("businesses").select("timezone")
   .eq("id",scope.businessId).single();
 if(cafeZone.error||!cafeZone.data?.timezone)throw new Error("Café timezone unavailable");
 const parts=new Intl.DateTimeFormat("en-US",{timeZone:cafeZone.data.timezone,
   year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
 const part=(kind:string)=>parts.find(p=>p.type===kind)?.value??"";
 const localDate=part("year")+"-"+part("month")+"-"+part("day");
 switch(name){
  case "propose_schedule":{
   const d=input as z.infer<typeof staffProposalInputs.propose_schedule>;
   ensure(isoDay(d.week_start)===1&&d.week_start>=localDate,"Choose a future Monday");
   const last=add(d.week_start,6),old=shifts.filter(x=>x.local_date>=d.week_start&&x.local_date<=last);
   ensure(old.every(x=>x.status==="draft"),"Sent shifts cannot be replaced");
   const keys=new Set<string>();
   for(const s of d.shifts){
    active(s.employee_id);ensure(s.date>=d.week_start&&s.date<=last,"Shift must fall in the selected week");
    ensure(s.start!==s.end&&s.break_minutes<(s.end>s.start?(Date.parse("2000-01-01T"+s.end+"Z")-Date.parse("2000-01-01T"+s.start+"Z"))/60000:1440),"Invalid shift or break");
    const k=s.employee_id+"|"+s.date+"|"+s.start;
    ensure(!keys.has(k),"Duplicate staff shift");keys.add(k);
   }
   item("Week "+d.week_start,old.map(s=>shown(s.employee_id)+" "+fmtShift(s)).join("\n")||"No draft shifts",
     d.shifts.map(s=>shown(s.employee_id)+" "+when(s)).join("\n")||"No shifts");
   payload={week_start:d.week_start,shifts:d.shifts};break;
  }
  case "propose_shift_change":{
   const d=input as z.infer<typeof staffProposalInputs.propose_shift_change>;
   const person=active(d.shift.employee_id);const old=d.shift_id?shifts.find(s=>s.id===d.shift_id):null;
   ensure(!d.shift_id||old,"Shift no longer exists");
   ensure(!old||old.status==="draft","A sent shift cannot be changed");
   ensure(!old||(old.employee_id===person.id&&old.local_date===d.shift.date),"Cannot change a shift's identity");
   ensure(!d.remove||old,"A new shift cannot be removed");
   ensure(d.shift.date>=localDate,"Past shifts cannot be changed");
   ensure(d.shift.start!==d.shift.end,"Shift must have a duration");
   item(person.display_name,old?fmtShift(old)+" ("+old.break_minutes+"m break)":"No shift",
     d.remove?"Removed":when(d.shift)+" ("+d.shift.break_minutes+"m break)");
   payload={shift_id:d.shift_id,shift:d.shift,remove:d.remove};break;
  }
  case "propose_add_staff":{
   const d=input as z.infer<typeof staffProposalInputs.propose_add_staff>;
   ensure(!people.some(p=>p.active&&p.display_name.toLowerCase()===d.name.toLowerCase()),"Staff name already in use");
   item(d.name,"Not on team",d.name+" · "+(d.role??"No role")+" · "+d.wage_cents+"¢/hour · "+(d.phone??"No phone"));
   payload=d;break;
  }
  case "propose_staff_change":{
   const d=input as z.infer<typeof staffProposalInputs.propose_staff_change>,p=active(d.employee_id);
   ensure(p.wage_period==="hour","Salary workers require manual review");
   item(p.display_name,p.display_name+" · "+(p.role??"No role")+" · "+display(p.wage_amount_cents)+"¢/hour · "+(p.phone_e164??"No phone")+" · "+(p.active?"Active":"Inactive"),
     d.name+" · "+(d.role??"No role")+" · "+d.wage_cents+"¢/hour · "+(d.phone??"No phone")+" · "+(d.active?"Active":"Inactive"));
   payload=d;break;
  }
  case "propose_availability_change":{
   const d=input as z.infer<typeof staffProposalInputs.propose_availability_change>;
   const parsed=parseAvailabilityText(d.instruction,localDate);
   ensure(parsed,"Use an unambiguous staff name, weekdays, and times");
   const matched=people.filter(p=>p.active&&p.display_name.trim().toLocaleLowerCase()===parsed.personName.trim().toLocaleLowerCase());
   ensure(matched.length===1,"Staff name not found or ambiguous");
   const p=matched[0];const rows=(availabilityResult.data??[]).filter(x=>x.employee_id===p.id);
   const old=rows.map(x=>DAY[x.day_of_week]+" "+String(x.start_local).slice(0,5)+"–"+String(x.end_local).slice(0,5)).join(", ")||"No recurring availability";
   const windows=parsed.availability.map(x=>({day:x.day,start:x.start,end:x.end}));
   ensure(windows.every(x=>x.start!==null&&x.end!==null),"Incomplete availability window");
   const next=parsed.offDates?.length?"Off "+parsed.offDates.join(", "):
     windows.map(x=>DAY[x.day]+" "+x.start+"–"+x.end).join(", ")||"Unavailable all days";
   item(p.display_name,parsed.offDates?.length?
     (exceptionsResult.data??[]).filter(x=>x.employee_id===p.id).map(x=>x.local_date+" "+x.exception_type).join(", ")||"No dated exceptions":old,next);
   payload={employee_id:p.id,availability:windows,off_dates:parsed.offDates??[],effective_from:localDate};break;
  }
  case "propose_rule_change":{
   const d=input as z.infer<typeof staffProposalInputs.propose_rule_change>;
   const bool=d.rule.endsWith("_enabled");
   ensure(bool?(d.boolean_value!==null&&d.number_value===null):(d.boolean_value===null&&d.number_value!==null),"Rule value type does not match");
   // Mirror the database's bounds; SQL constraints remain authoritative.
   const limits:Record<string,[number,number]>={
    meal_break_minutes:[0,240],meal_break_after_minutes:[0,1440],rest_break_minutes:[0,60],rest_break_every_minutes:[60,1440],
    weekly_ot_after_minutes:[0,10080],ot_multiplier_bp:[10000,50000],daily_ot_after_minutes:[0,1440],max_shift_minutes:[30,1440],
    min_shift_minutes:[0,1440],min_rest_minutes:[0,1440],min_headcount:[1,30],
    prep_minutes_before_open:[0,240],prep_minutes_after_close:[0,240]};
   const v=bool?d.boolean_value:d.number_value;
   ensure(bool||(limits[d.rule]&&d.number_value!>=limits[d.rule][0]&&d.number_value!<=limits[d.rule][1]),"Rule outside allowed range");
   const defaults=(await import("@/lib/calc/scheduling/teamRuleDefaults")).DEFAULT_TEAM_RULES;
   item(d.rule,display((rulesResult.data as Record<string,unknown>|null)?.[d.rule]??defaults[d.rule as keyof typeof defaults]),display(v));
   payload={rule:d.rule,boolean_value:d.boolean_value,number_value:d.number_value};break;
  }
  case "propose_send_schedule":{
   const d=input as z.infer<typeof staffProposalInputs.propose_send_schedule>;
   ensure(isoDay(d.week_start)===1,"Select a Monday");
   const week=shifts.filter(x=>x.local_date>=d.week_start&&x.local_date<=add(d.week_start,6));
   const eligible=people.filter(p=>p.active&&p.phone_e164&&p.whatsapp_opt_in&&week.some(s=>s.employee_id===p.id));
   ensure(week.length>0,"No shifts scheduled for this week");
   item("Week "+d.week_start,"Not prepared",
     "Prepare only (no messages sent): "+eligible.map(p=>p.display_name).join(", ")+
     "\n"+week.filter(s=>eligible.some(p=>p.id===s.employee_id))
       .map(s=>shown(s.employee_id)+" "+fmtShift(s)).join("\n"));
   payload={week_start:d.week_start};break;
  }
 }
 const afterToken=await readToken(scope);
 ensure(beforeToken===afterToken,"Staff data changed while preparing preview; try again");
 return {effect:{operation:name,expectedToken:beforeToken,preview,payload},
   baseline:{source:"staff_schedule",status:"actual"},monitorSpec:{durationDays:1,metricScope:"staff"}};
}
export const staffCapabilities=names.map(name=>registerLoopCapability({
 id:staffCapabilityId(name),version:1,inputSchema:staffProposalInputs[name] as z.ZodType<unknown>,effectSchema,
 proposalDescription:"Create an inert staff action card requiring a fresh explicit owner approval.",
 simulate:(scope,raw)=>prepare(scope,name,raw),
 // The approval endpoint owns the atomic SQL commit; never use the generic split commit.
 commit:async()=>{throw new Error("staff_commit_requires_atomic_owner_approval");},
 monitor:async()=>null,
 report:async()=>({status:"insufficient_evidence" as const,result:{},recommendation:"adjust" as const,source:"staff_approval"}),
}));
