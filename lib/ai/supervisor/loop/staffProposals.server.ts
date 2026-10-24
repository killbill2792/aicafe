import "server-only";
import {z} from "zod";
import {cardValueSchema,diffFields,type CardValue,type DiffField} from "@/lib/format/values";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {readStaffProposalToken,readStaffProposalSources,
 type StaffProposalShift as Shift} from "@/lib/data/staffProposalSources.server";
import {parseAvailabilityText} from "@/lib/calc/scheduling/parseAvailabilityText";
import {assertStaffShiftPlan,formatStaffApprovalRuleValue,formatStaffShiftWithBreak} from "@/lib/calc/scheduling/staffProposalValidation";
import {staffProposalInputs,type StaffProposalName} from "@/lib/ai/agent/tools/staffProposals";
import {registerLoopCapability,type OwnerLoopScope} from "./engine";

const names=Object.keys(staffProposalInputs) as StaffProposalName[];
export const staffCapabilityId=(name:StaffProposalName)=>"olivia.staff_"+name+".v2";
export const isStaffCapabilityId=(id:string)=>names.some(n=>id==="olivia.staff_"+n+".v1"||staffCapabilityId(n)===id);
const line=z.strictObject({field:z.string().max(160),label:z.string().max(220),
 before:cardValueSchema.nullable(),after:cardValueSchema.nullable()});
export const staffDependencySchema=z.strictObject({
 version:z.literal(2),kind:z.enum(["staff_change","add_staff","shift_change","schedule","send_schedule","availability","rule"]),
 employeeId:z.string().uuid().optional(),shiftId:z.string().uuid().nullable().optional(),
 date:z.string().optional(),weekStart:z.string().optional(),staffIds:z.array(z.string().uuid()).optional(),
 rule:z.string().optional(),
});
export type StaffDependencyScope=z.infer<typeof staffDependencySchema>;
export function staffDependencyScope(name:StaffProposalName,p:Record<string,unknown>):StaffDependencyScope{
 switch(name){
  case "propose_staff_change":return {version:2,kind:"staff_change",employeeId:String(p.employee_id)};
  case "propose_add_staff":return {version:2,kind:"add_staff"};
  case "propose_shift_change":{
   const shift=p.shift as {employee_id:string;date:string};
   return {version:2,kind:"shift_change",employeeId:shift.employee_id,date:shift.date,
     shiftId:typeof p.shift_id==="string"?p.shift_id:null};
  }
  case "propose_schedule":return {version:2,kind:"schedule",weekStart:String(p.week_start),
    staffIds:[...new Set((p.shifts as Array<{employee_id:string}>).map(x=>x.employee_id))].sort()};
  case "propose_send_schedule":return {version:2,kind:"send_schedule",weekStart:String(p.week_start)};
  case "propose_availability_change":return {version:2,kind:"availability",employeeId:String(p.employee_id)};
  case "propose_rule_change":return {version:2,kind:"rule",rule:String(p.rule)};
 }
}
const effectSchema=z.strictObject({
 operation:z.enum(["propose_schedule","propose_shift_change","propose_add_staff",
  "propose_staff_change","propose_availability_change","propose_rule_change","propose_send_schedule"]),
 expectedToken:z.string().regex(/^[a-f0-9]{32}$/),scopeVersion:z.literal(2),
 dependencyScope:staffDependencySchema,preview:z.array(line).min(1).max(100),
 payload:z.record(z.string(),z.unknown()),
});
const weekdayKeys=["sun","mon","tue","wed","thu","fri","sat"] as const;
const when=(x:{date:string;start:string;end:string})=>x.date+" "+x.start+"–"+x.end;
const isoDay=(d:string)=>new Date(d+"T12:00:00Z").getUTCDay();
const add=(d:string,n:number)=>new Date(Date.parse(d+"T12:00:00Z")+86400000*n).toISOString().slice(0,10);
const fmtShift=(s:Shift)=>when({date:s.local_date,start:s.start_local.slice(0,5),end:s.end_local.slice(0,5)});
function ensure(ok:unknown,msg:string):asserts ok{if(!ok)throw new Error(msg);}
export {readStaffProposalToken};
async function prepare(scope:OwnerLoopScope,name:StaffProposalName,raw:unknown){
 const input=staffProposalInputs[name].parse(raw);
 const copy=({en,es,ar} as const)[scope.locale].StaffApprovalCard;
 const dayCopy=({en,es,ar} as const)[scope.locale].SchedulingAvailability;
 const days=weekdayKeys.map(key=>dayCopy[key]);
 const relevantWeek=name==="propose_schedule"||name==="propose_send_schedule"
   ?(input as {week_start:string}).week_start:null;
 const changeDate=name==="propose_shift_change"
   ?(input as {shift:{date:string}}).shift.date:null;
 const from=relevantWeek?add(relevantWeek,-1):changeDate?add(changeDate,-1):null;
 const to=relevantWeek?add(relevantWeek,7):changeDate?add(changeDate,1):null;
 const {people,shifts,rules,availability,exceptions,timezone}=
  await readStaffProposalSources(scope,from,to);
 const active=(id:string)=>{const p=people.find(p=>p.id===id&&p.active);ensure(p,"Active staff member not found");return p;};
 const preview:DiffField[]=[];
 const shown=(id:string)=>people.find(p=>p.id===id)?.display_name??id;
 const item=(field:string,label:string,before:CardValue|null,after:CardValue|null)=>
   preview.push(...diffFields(before?[{field,label,value:before}]:[],after?[{field,label,value:after}]:[]));
 const text=(value:string):CardValue=>({kind:"text",text:value});
 const missing=(reason:"noWage"|"noRole"|"noPhone"):CardValue=>({kind:"missing",reason});
 let payload:Record<string,unknown>={};
 const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,
   year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
 const part=(kind:string)=>parts.find(p=>p.type===kind)?.value??"";
 const localDate=part("year")+"-"+part("month")+"-"+part("day");
 switch(name){
  case "propose_schedule":{
   const d=input as z.infer<typeof staffProposalInputs.propose_schedule>;
   ensure(isoDay(d.week_start)===1&&d.week_start>=localDate,"Choose a future Monday");
   const last=add(d.week_start,6),old=shifts.filter(x=>x.local_date>=d.week_start&&x.local_date<=last);
   ensure(old.every(x=>x.status==="draft"),"Sent shifts cannot be replaced");
   // Replacement keeps adjacent-week shifts; include those to catch overnight
   // overlaps on both Monday and Sunday (the week itself is replaced).
   const retained=shifts.filter(x=>x.local_date<d.week_start||x.local_date>last)
     .filter(x=>d.shifts.some(s=>s.employee_id===x.employee_id))
     .map(x=>({employee_id:x.employee_id,date:x.local_date,
       start:x.start_local.slice(0,5),end:x.end_local.slice(0,5),
       break_minutes:x.break_minutes}));
   assertStaffShiftPlan([...d.shifts,...retained]);
   for(const s of d.shifts){
    active(s.employee_id);ensure(s.date>=d.week_start&&s.date<=last,"Shift must fall in the selected week");
    // Overlaps, duplicates and breaks are checked in the pure planner above.
   }
   for(const date of [...new Set([...old.map(x=>x.local_date),...d.shifts.map(x=>x.date)])].sort()){
     const before=old.filter(x=>x.local_date===date).map(x=>shown(x.employee_id)+" "+formatStaffShiftWithBreak({
       date:x.local_date,start:x.start_local.slice(0,5),end:x.end_local.slice(0,5),break_minutes:x.break_minutes},copy.breakMinutes)).sort().join("\n");
     const after=d.shifts.filter(x=>x.date===date).map(x=>shown(x.employee_id)+" "+formatStaffShiftWithBreak(x,copy.breakMinutes)).sort().join("\n");
     item("schedule",copy.week+" "+date,before?text(before):null,after?text(after):null);
   }
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
   if(!d.remove)assertStaffShiftPlan([d.shift,
     ...shifts.filter(x=>x.id!==d.shift_id&&x.employee_id===d.shift.employee_id).map(x=>({
       employee_id:x.employee_id,date:x.local_date,start:x.start_local.slice(0,5),
       end:x.end_local.slice(0,5),break_minutes:x.break_minutes}))]);
   item("shift",person.display_name,old?text(fmtShift(old)+" ("+old.break_minutes+" "+copy.breakMinutes+")"):null,
      d.remove?null:text(when(d.shift)+" ("+d.shift.break_minutes+" "+copy.breakMinutes+")"));
   payload={shift_id:d.shift_id,shift:d.shift,remove:d.remove};break;
  }
  case "propose_add_staff":{
   const d=input as z.infer<typeof staffProposalInputs.propose_add_staff>;
   ensure(!people.some(p=>p.active&&p.display_name.toLowerCase()===d.name.toLowerCase()),"Staff name already in use");
   item("name","Name",null,text(d.name));
   item("role","Role",null,d.role?text(d.role):missing("noRole"));
   item("wage","Hourly wage",null,{kind:"moneyRate",cents:d.wage_cents,per:"hour"});
   item("phone","Phone",null,d.phone?text(d.phone):missing("noPhone"));
   item("active","Active",null,{kind:"bool",value:true});
   payload=d;break;
  }
  case "propose_staff_change":{
   const d=input as z.infer<typeof staffProposalInputs.propose_staff_change>;
   const p=people.find(p=>p.id===d.employee_id);
   ensure(p,"Staff member not found");
   ensure(p.wage_period==="hour","Salary workers require manual review");
   item("name","Name",text(p.display_name),text(d.name));
   item("role","Role",p.role?text(p.role):missing("noRole"),d.role?text(d.role):missing("noRole"));
   item("wage","Hourly wage",p.wage_amount_cents===null?missing("noWage"):
     {kind:"moneyRate",cents:p.wage_amount_cents,per:"hour"},{kind:"moneyRate",cents:d.wage_cents,per:"hour"});
   item("phone","Phone",p.phone_e164?text(p.phone_e164):missing("noPhone"),d.phone?text(d.phone):missing("noPhone"));
   item("active","Active",{kind:"bool",value:p.active},{kind:"bool",value:d.active});
   payload=d;break;
  }
  case "propose_availability_change":{
   const d=input as z.infer<typeof staffProposalInputs.propose_availability_change>;
   const parsed=parseAvailabilityText(d.instruction,localDate);
   ensure(parsed,"Use an unambiguous staff name, weekdays, and times");
   const matched=people.filter(p=>p.active&&p.display_name.trim().toLocaleLowerCase()===parsed.personName.trim().toLocaleLowerCase());
   ensure(matched.length===1,"Staff name not found or ambiguous");
   const p=matched[0];const rows=availability.filter(x=>x.employee_id===p.id);
   const old=rows.map(x=>days[x.day_of_week]+" "+String(x.start_local).slice(0,5)+"–"+String(x.end_local).slice(0,5)).join(", ")||copy.noAvailability;
   const windows=parsed.availability.map(x=>({day:x.day,start:x.start,end:x.end}));
   ensure(windows.every(x=>x.start!==null&&x.end!==null),"Incomplete availability window");
   const next=parsed.offDates?.length?copy.off+" "+parsed.offDates.join(", "):
     windows.map(x=>days[x.day]+" "+x.start+"–"+x.end).join(", ")||copy.noAvailability;
   const absenceLabels:Record<string,string>={
     unavailable:copy.exceptionUnavailable,approved_leave:copy.exceptionApprovedLeave,
     replace_day:copy.exceptionReplaceDay,add_available:copy.exceptionAddAvailable,
     hours_cap:copy.exceptionHoursCap
    };
    if(parsed.offDates?.length){
      for(const date of parsed.offDates){
        const existing=exceptions.filter(x=>x.employee_id===p.id&&x.local_date===date)
           .map(x=>absenceLabels[x.exception_type]??copy.exceptionOther).sort().join(", ");
        item("availability",date,existing?text(existing):null,text(copy.off));
      }
    }else{
      for(const day of [...new Set([...rows.map(x=>x.day_of_week),...windows.map(x=>x.day)])].sort()){
        const oldTimes=rows.filter(x=>x.day_of_week===day).map(x=>String(x.start_local).slice(0,5)+"–"+String(x.end_local).slice(0,5)).sort().join(", ");
        const newTimes=windows.filter(x=>x.day===day).map(x=>x.start+"–"+x.end).sort().join(", ");
        item("availability",days[day],oldTimes?text(oldTimes):null,newTimes?text(newTimes):null);
      }
    }
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
   const ruleLabels:Record<string,string>={"meal_break_enabled":"mealBreak","meal_break_minutes":"mealMinutes","meal_break_after_minutes":"mealAfter","rest_break_enabled":"paidRest","rest_break_minutes":"restMinutes","rest_break_every_minutes":"restEvery","weekly_ot_enabled":"weeklyOvertime","weekly_ot_after_minutes":"weeklyAfter","ot_multiplier_bp":"multiplier","daily_ot_enabled":"dailyOvertime","daily_ot_after_minutes":"dailyAfter","max_shift_enabled":"longestShift","max_shift_minutes":"longestMinutes","min_shift_enabled":"shortestShift","min_shift_minutes":"shortestMinutes","min_rest_enabled":"betweenShifts","min_rest_minutes":"betweenMinutes","coverage_enabled":"minimumCoverage","min_headcount":"peopleWhileOpen","prep_minutes_before_open":"prepBeforeOpen","prep_minutes_after_close":"prepAfterClose"};
   const translatedRules=({en,es,ar} as const)[scope.locale].StaffSchedule as Record<string,string>;
   const prior=rules?.[d.rule]??defaults[d.rule as keyof typeof defaults];
   const typed=(value:unknown):CardValue=>typeof value==="boolean"?{kind:"bool",value}:
     typeof value==="number"?(d.rule==="ot_multiplier_bp"?{kind:"percent",bps:value}:
       d.rule.endsWith("_minutes")?{kind:"duration",minutes:value}:{kind:"count",n:value}):
       text(formatStaffApprovalRuleValue(value,copy));
   item("rule",translatedRules[ruleLabels[d.rule]]??copy.ruleFallback,typed(prior),typed(v));
   payload={rule:d.rule,boolean_value:d.boolean_value,number_value:d.number_value};break;
  }
  case "propose_send_schedule":{
   const d=input as z.infer<typeof staffProposalInputs.propose_send_schedule>;
   ensure(isoDay(d.week_start)===1,"Select a Monday");
   const week=shifts.filter(x=>x.local_date>=d.week_start&&x.local_date<=add(d.week_start,6));
   const eligible=people.filter(p=>p.active&&week.some(s=>s.employee_id===p.id));
   ensure(week.length>0,"No shifts scheduled for this week");

   item("schedule",copy.week+" "+d.week_start,null,text(copy.preparedNotSent+": "+eligible.map(p=>p.display_name).join(", ")+
     "\n"+week.filter(x=>eligible.some(p=>p.id===x.employee_id)).map(x=>shown(x.employee_id)+" "+fmtShift(x)).join("\n")));
   payload={week_start:d.week_start};break;
  }
 }
 const dependencyScope=staffDependencySchema.parse(staffDependencyScope(name,payload));
 const beforeToken=await readStaffProposalToken(scope,dependencyScope);
 const reread=await readStaffProposalSources(scope,from,to);
 const afterToken=await readStaffProposalToken(scope,dependencyScope);
 ensure(beforeToken===afterToken&&JSON.stringify({people,shifts,rules,availability,exceptions})===
   JSON.stringify({people:reread.people,shifts:reread.shifts,rules:reread.rules,
     availability:reread.availability,exceptions:reread.exceptions}),
   "Staff data changed while preparing preview; try again");
 ensure(preview.length>0,"No changes to propose");
 return {effect:{operation:name,scopeVersion:2,dependencyScope,expectedToken:beforeToken,preview,payload},
   baseline:{source:"staff_schedule",status:"actual"},monitorSpec:{durationDays:1,metricScope:"staff"}};
}
export const staffCapabilities=names.map(name=>registerLoopCapability({
 id:staffCapabilityId(name),version:2,inputSchema:staffProposalInputs[name] as z.ZodType<unknown>,effectSchema,
 dependencyScope:(effect)=>staffDependencySchema.parse(effect.dependencyScope),
 proposalDescription:"Create an inert staff action card requiring a fresh explicit owner approval.",
 simulate:(scope,raw)=>prepare(scope,name,raw),
 // The approval endpoint owns the atomic SQL commit; never use the generic split commit.
 commit:async()=>{throw new Error("staff_commit_requires_atomic_owner_approval");},
 monitor:async()=>null,
 report:async()=>({status:"insufficient_evidence" as const,result:{},recommendation:"adjust" as const,source:"staff_approval"}),
}));
