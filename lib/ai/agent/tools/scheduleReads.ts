import {z} from "zod";
import {formatInTimeZone} from "date-fns-tz";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {getTeam,getWeekSchedule,getShiftCost} from "@/lib/actions/schedule";
import {getTeamRules} from "@/lib/actions/teamRules";
import {staffReadScope,mondayOfLocalDate} from "@/lib/scheduling/staffScope.server";
import {coverageGaps,uncheckedCoverageDays} from "@/lib/calc/scheduling/coverageGaps";
import {missingWageInputs,aggregateCosts} from "@/lib/calc/scheduling/shiftCost";
import type {AgentToolContext,AgentToolResult} from "./index";
import {resolveEntity,resolveChosenEntity,ownerNamedTarget,choicePayload,ownerChoiceGuard} from "../resolve";
import {money} from "../explain";
import {shiftCost} from "@/lib/calc/scheduling/shiftCost";
const week=z.strictObject({week_start:z.iso.date().nullable()});
const namedWeek=week.extend({name:z.string().max(100).nullable()});
const none=z.strictObject({});
const estimate=z.strictObject({
 employee_id:z.string().uuid(),date:z.iso.date(),
 start:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
 end:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
 break_minutes:z.number().int().min(0).max(240).nullable()
});
const fail=(source:string,period:{from:string;to:string}|null,why:string):AgentToolResult=>({
 source,period,agentId:"olivia",missing:[why],estimated:false
});
async function localWeek(requested:string|null,ctx:AgentToolContext){
 const scope=await staffReadScope();
 const today=scope.ok?scope.today:ctx.asOf;
 return mondayOfLocalDate(requested??today);
}
type WeekData=Extract<Awaited<ReturnType<typeof getWeekSchedule>>,{ok:true}>["data"];
/** The Team screen and chat share getWeekSchedule. Toast plans never count as paid labor. */
export function mergeScheduleShifts(data:Pick<WeekData,"shifts"|"posShifts"|"team"|"timezone">){
 const ids=new Set(data.team.map(p=>p.id));
 const app=data.shifts.filter(s=>ids.has(s.employeeId)).map(s=>({
   id:s.id,date:s.date,employeeId:s.employeeId,employeeName:s.employeeName,
   start:s.start,end:s.end,paidMinutes:s.paidMinutes,costCents:s.costCents,
   estimated:s.estimated,source:"app" as const,
 }));
 const pos=(data.posShifts??[]).map(s=>({
   id:s.id,date:formatInTimeZone(new Date(s.start),data.timezone,"yyyy-MM-dd"),
   employeeId:s.employeeId??null,employeeName:s.employeeName,
   start:formatInTimeZone(new Date(s.start),data.timezone,"HH:mm"),
   end:formatInTimeZone(new Date(s.end),data.timezone,"HH:mm"),
   paidMinutes:null,costCents:null,estimated:null,source:"toast" as const,
 }));
 // Only linked identities can be matched to an app shift. Two unlinked
 // Toast staff can share a display name and start time; never erase either.
 const key=(s:(typeof app)[number]|(typeof pos)[number])=>
  (s.employeeId?"id:"+s.employeeId:s.source+":"+s.id)+"|"+s.date+"|"+s.start;
 const seen=new Set(app.map(key));
 return [...app,...pos.filter(s=>{const k=key(s);if(seen.has(k))return false;seen.add(k);return true;})]
  .sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
}
function toastScheduleNotes(data:Pick<WeekData,"posScheduleError">,locale:AgentToolContext["locale"]){
 if(!data.posScheduleError)return [];
 return [{en,es,ar}[locale].DataNotes.toastScheduleReadFailed.replace("{reason}",data.posScheduleError)];
}
export const scheduleReadTools={
 get_team:{
  agentId:"olivia",schema:namedWeek,
  description:"Read active team, individual weekly hours and wage estimate flags. Pass week_start as YYYY-MM-DD Monday or null for this business week.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=namedWeek.parse(raw),ws=await localWeek(input.week_start,ctx);
   const result=await getWeekSchedule({weekStart:ws});
   if(!result.ok)return fail("staff_week",null,result.error);
   let selected=result.data.team;
   if(input.name){
     const chosen=resolveChosenEntity(ctx.resolveState,selected,person=>person.id);
     if(chosen)selected=[chosen];
     else{
       const matched=resolveEntity("employee",input.name,selected,{nameOf:person=>person.name,idOf:person=>person.id,describe:person=>person.role??"Team"});
       if(matched.status!=="resolved")return {...choicePayload(matched,"employees+scheduled_shifts",null),agentId:"olivia"};
       selected=[matched.value];
     }
   }
   if(input.name&&selected.length===1&&!ownerNamedTarget(ctx.resolveState,selected[0].id,selected[0].name))
     return fail("employees+scheduled_shifts",null,"targetNotConfirmed");
   const activeIds=new Set(result.data.team.map(person=>person.id));
   const activeShifts=result.data.shifts.filter(shift=>activeIds.has(shift.employeeId));
   const all=mergeScheduleShifts(result.data);
   const scoped=input.name?all.filter(shift=>selected.some(person=>
     person.id===shift.employeeId||person.name.toLocaleLowerCase()===shift.employeeName.toLocaleLowerCase())):all;
   const totals=aggregateCosts(activeShifts);
   const people=selected.slice(0,30),shifts=scoped.slice(0,30);
   return {source:"employees+scheduled_shifts",period:{from:ws,to:new Date(Date.parse(ws+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)},
    agentId:"olivia",dataNotes:toastScheduleNotes(result.data,ctx.locale),missing:[...(result.data.posScheduleError?["toastScheduleReadFailed"]:[]),...(selected.length>30?["morePeople"]:[]),
     ...(scoped.length>30?["moreShifts"]:[]),
     ...(!input.name?missingWageInputs(totals):[])],estimated:input.name?null:totals.estimated,
    people:people.map(p=>({id:p.id,name:p.name,role:p.role,minWeeklyMinutes:p.minWeeklyMinutes,
      maxWeeklyMinutes:p.maxWeeklyMinutes,hasKnownWage:p.wageCents!==null})),
    shifts:shifts,
    weeklyPaidMinutes:input.name?null:totals.paidMinutes,
    knownWagesCents:input.name?null:totals.knownCostCents,
    missingWageCount:input.name?null:totals.unknownCount};
  }
 },
 get_week_schedule:{
  agentId:"olivia",schema:week,
  description:"Read dated owner schedule for a business-local Monday-to-Sunday week, including estimated wages, shifts, totals and coverage gaps. Pass null for current week.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const p=week.parse(raw),ws=await localWeek(p.week_start,ctx);
   const result=await getWeekSchedule({weekStart:ws});
   if(!result.ok)return fail("scheduled_shifts",null,result.error);
   const data=result.data,activeIds=new Set(data.team.map(p=>p.id));
   const activeShifts=data.shifts.filter(s=>activeIds.has(s.employeeId));
   const combined=mergeScheduleShifts(data);
   const scheduled=combined.length>0,hasCostedShifts=activeShifts.length>0,totals=aggregateCosts(activeShifts);
   const adjacent=data.adjacentShifts.filter(s=>activeIds.has(s.employeeId));
   const gaps=scheduled?coverageGaps(data.dates,[...adjacent,...activeShifts],
     data.openHours,data.rules.coverage_enabled?data.rules.min_headcount:0):[];
   return {source:"scheduled_shifts",period:{from:data.dates[0],to:data.dates[6]},
     agentId:"olivia",scheduleSet:scheduled,href:"/staff?tab=schedule",
     dataNotes:toastScheduleNotes(data,ctx.locale),
     missing:[...(data.posScheduleError?["toastScheduleReadFailed"]:[]),...(!scheduled?["scheduleNotSet"]:[]),
       ...(combined.length>40?["moreShifts"]:[]),
       ...(hasCostedShifts?missingWageInputs(totals):[]),
       ...(!data.rules.coverage_enabled?["coverageDisabled"]:
       uncheckedCoverageDays(data.dates,data.openHours,true).length?["openHoursIncomplete"]:[])],
     estimated:hasCostedShifts?totals.estimated:null,estimatedShiftCount:hasCostedShifts?totals.estimateCount:null,
     paidMinutes:hasCostedShifts?totals.paidMinutes:null,knownWagesCents:hasCostedShifts?totals.knownCostCents:null,
     shifts:combined.slice(0,40),
     gaps:gaps.slice(0,15)};
  }
 },
 get_labor_rules:{
  agentId:"olivia",schema:none,
  description:"Read current owner rules and default labor settings with unambiguous owner-written custom rules; not a verified legal opinion.",
  execute:async(raw:unknown):Promise<AgentToolResult>=>{
   none.parse(raw);const result=await getTeamRules();
   if(!result.ok)return fail("team_rules",null,result.error);
   const {custom,owner_set,...values}=result.data;
   return {source:"team_rules+staff_custom_rules",period:null,agentId:"olivia",
     missing:custom.length>30?["moreCustomRules"]:[],estimated:false,
     verifiedLegalProfile:false,defaultsOverridden:owner_set,
     settings:values,customRules:custom.slice(0,30).map((r:{id:string;rule_text:string})=>({id:r.id,text:r.rule_text}))};
  }
 },
 get_coverage_gaps:{
  agentId:"olivia",schema:week,
  description:"Check understaffed time ranges against configured café open hours and required headcount. A missing open-hours setup is not zero gaps.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const p=week.parse(raw),ws=await localWeek(p.week_start,ctx);
   const whole=await getWeekSchedule({weekStart:ws});
   if(!whole.ok)return fail("coverage_gaps",null,whole.error);
   const data=whole.data,activeIds=new Set(data.team.map(p=>p.id));
   const activeShifts=data.shifts.filter(s=>activeIds.has(s.employeeId));
   const scheduled=mergeScheduleShifts(data).length>0;
   const adjacent=data.adjacentShifts.filter(s=>activeIds.has(s.employeeId));
   const gaps=scheduled?coverageGaps(data.dates,[...adjacent,...activeShifts],
     data.openHours,data.rules.coverage_enabled?data.rules.min_headcount:0):[];
   return {source:"scheduled_shifts+locations.open_hours",period:{from:ws,to:data.dates[6]},
    agentId:"olivia",scheduleSet:scheduled,href:"/staff?tab=schedule",
    dataNotes:toastScheduleNotes(data,ctx.locale),missing:[...(data.posScheduleError?["toastScheduleReadFailed"]:[]),...(!scheduled?["scheduleNotSet"]:[]),
      ...(!data.rules.coverage_enabled?["coverageDisabled"]:
      uncheckedCoverageDays(data.dates,data.openHours,true).length?["openHoursIncomplete"]:[]),
      ...(gaps.length>30?["moreGaps"]:[])],estimated:false,gaps:gaps.slice(0,30)};
  }
 },
 get_shift_cost:{
  agentId:"olivia",schema:estimate,
  description:"Calculate an uncommitted shift's paid minutes and wages from the same deterministic cost engine used by the shift sheet; missing wage is estimated or unknown.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const p=estimate.parse(raw);
   const team=ctx.resolveState?await getTeam({weekStart:mondayOfLocalDate(ctx.asOf)}):null;
   if(team&&!team.ok)return fail("shift_cost",null,"staffIdentityUnavailable");
   const person=team?.ok?team.data.team.find(person=>person.id===p.employee_id):undefined;
   if(team?.ok&&!person)return fail("shift_cost",null,"staffNotFound");
   if(person&&team?.ok){
     const resolved=resolveEntity("staff",person.name,team.data.team,{
       nameOf:row=>row.name,idOf:row=>row.id,describe:row=>row.role??"Team"});
     if(resolved.status==="ambiguous"){
       const needed=ownerChoiceGuard(ctx.resolveState,p.employee_id,resolved.candidates);
       if(needed)return {source:"shift_cost",period:null,agentId:"olivia",...needed};
     }
   }
   const guard=ownerChoiceGuard(ctx.resolveState,p.employee_id);
   if(guard)return {source:"shift_cost",period:null,agentId:"olivia",...guard};
   if(person&&!ownerNamedTarget(ctx.resolveState,p.employee_id,person.name))
     return fail("shift_cost",null,"targetNotConfirmed");
   const res=await getShiftCost({employeeId:p.employee_id,date:p.date,start:p.start,end:p.end,
    breakMinutes:p.break_minutes??undefined});
   if(!res.ok)return fail("shift_cost",null,res.error);
   const modeled=person&&p.break_minutes!==null&&person.wageCents!==null?
     shiftCost({employeeId:person.id,date:p.date,start:p.start,end:p.end,
       overnight:p.end<p.start,breakMinutes:p.break_minutes,wageCents:person.wageCents}):null;
   const canExplain=res.data.costCents!==null&&modeled?.costCents===res.data.costCents;
   return {source:"employees+shiftCost",period:{from:p.date,to:p.date},
    agentId:"olivia",missing:res.data.unknown?["wageAndEstimateMissing"]:[],
    estimated:res.data.estimated,unknown:res.data.unknown,
    employeeId:res.data.employeeId,paidMinutes:res.data.paidMinutes,costCents:res.data.costCents,
    explain:canExplain?[{label:person!.name,inputs:[
      {name:"paidTime",value:{kind:"duration" as const,minutes:res.data.paidMinutes}},
      {name:"hourlyWage",value:{kind:"moneyRate" as const,cents:person!.wageCents!,per:"hour" as const}}],
      formula:"prorate",result:money(res.data.costCents!),period:{from:p.date,to:p.date},
      source:"get_shift_cost",provenance:res.data.estimated?"estimate":"recorded"}]:[]};
  }
 }
} as const;
