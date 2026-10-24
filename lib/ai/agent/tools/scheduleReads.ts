import {z} from "zod";
import {getTeam,getWeekSchedule,getCoverageGaps,getShiftCost} from "@/lib/actions/schedule";
import {getTeamRules} from "@/lib/actions/teamRules";
import {staffReadScope,mondayOfLocalDate} from "@/lib/scheduling/staffScope.server";
import {uncheckedCoverageDays} from "@/lib/calc/scheduling/coverageGaps";
import {missingWageInputs} from "@/lib/calc/scheduling/shiftCost";
import type {AgentToolContext,AgentToolResult} from "./index";
import {resolveEntity,choicePayload,ownerChoiceGuard,normalizedName} from "../resolve";
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
export const scheduleReadTools={
 get_team:{
  agentId:"olivia",schema:namedWeek,
  description:"Read active team, individual weekly hours and wage estimate flags. Pass week_start as YYYY-MM-DD Monday or null for this business week.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=namedWeek.parse(raw),ws=await localWeek(input.week_start,ctx);
   const result=await getTeam({weekStart:ws});
   if(!result.ok)return fail("staff_week",null,result.error);
   let selected=result.data.team;
   if(input.name){
     const matched=resolveEntity("employee",input.name,selected,{nameOf:person=>person.name,idOf:person=>person.id,describe:person=>person.role??"Team"});
     if(matched.status!=="resolved")return {...choicePayload(matched,"employees+scheduled_shifts",null),agentId:"olivia"};
     selected=[matched.value];
   }
   const scoped=input.name?result.data.shifts.filter(shift=>selected.some(person=>
     person.id===shift.employeeId)):result.data.shifts;
   const people=selected.slice(0,30),shifts=scoped.slice(0,30);
   return {source:"employees+scheduled_shifts",period:{from:ws,to:new Date(Date.parse(ws+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)},
    agentId:"olivia",missing:[...(selected.length>30?["morePeople"]:[]),
     ...(scoped.length>30?["moreShifts"]:[]),
     ...(!input.name?missingWageInputs(result.data.totals):[])],estimated:result.data.totals.estimated,
    people:people.map(p=>({id:p.id,name:p.name,role:p.role,minWeeklyMinutes:p.minWeeklyMinutes,
      maxWeeklyMinutes:p.maxWeeklyMinutes,hasKnownWage:p.wageCents!==null})),
    shifts:shifts.map(s=>({employeeId:s.employeeId,date:s.date,paidMinutes:s.paidMinutes,
      costCents:s.costCents,estimated:s.estimated})),
    // Whole-team totals are not the selected employee's totals.
    weeklyPaidMinutes:input.name?null:result.data.totals.paidMinutes,
    knownWagesCents:input.name?null:result.data.totals.knownCostCents,
    missingWageCount:input.name?null:result.data.totals.unknownCount};
  }
 },
 get_week_schedule:{
  agentId:"olivia",schema:week,
  description:"Read dated owner schedule for a business-local Monday-to-Sunday week, including estimated wages, shifts, totals and coverage gaps. Pass null for current week.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const p=week.parse(raw),ws=await localWeek(p.week_start,ctx);
   const result=await getWeekSchedule({weekStart:ws});
   if(!result.ok)return fail("scheduled_shifts",null,result.error);
   const data=result.data;
   return {source:"scheduled_shifts",period:{from:data.dates[0],to:data.dates[6]},
     agentId:"olivia",missing:[...(data.shifts.length>40?["moreShifts"]:[]),
       ...missingWageInputs(data.total),
       ...(!data.rules.coverage_enabled?["coverageDisabled"]:
       uncheckedCoverageDays(data.dates,data.openHours,true).length?["openHoursIncomplete"]:[])],
     estimated:data.total.estimated,estimatedShiftCount:data.total.estimateCount,
     paidMinutes:data.total.paidMinutes,knownWagesCents:data.total.knownCostCents,
     shifts:data.shifts.slice(0,40).map(s=>({id:s.id,date:s.date,employeeId:s.employeeId,
       start:s.start,end:s.end,paidMinutes:s.paidMinutes,costCents:s.costCents,estimated:s.estimated})),
     gaps:data.gaps.slice(0,15)};
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
   const [gaps,whole]=await Promise.all([getCoverageGaps({weekStart:ws}),getWeekSchedule({weekStart:ws})]);
   if(!gaps.ok)return fail("coverage_gaps",null,gaps.error);
   if(!whole.ok)return fail("coverage_gaps",null,whole.error);
   return {source:"scheduled_shifts+locations.open_hours",period:{from:ws,to:whole.data.dates[6]},
    agentId:"olivia",missing:[...(!whole.data.rules.coverage_enabled?["coverageDisabled"]:
      uncheckedCoverageDays(whole.data.dates,whole.data.openHours,true).length?["openHoursIncomplete"]:[]),
      ...(gaps.data.gaps.length>30?["moreGaps"]:[])],estimated:false,gaps:gaps.data.gaps.slice(0,30)};
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
     if(resolved.status==="ambiguous"&&!ctx.resolveState?.chosenIds.has(p.employee_id.toLowerCase())&&
       !resolved.candidates.some(c=>c.id===p.employee_id&&
         normalizedName(ctx.resolveState?.ownerText??"").includes(normalizedName(c.label))))
       return {source:"shift_cost",period:null,agentId:"olivia",
         missing:["ownerChoiceRequired"],needsOwnerChoice:true,candidates:resolved.candidates};
   }
   const guard=ownerChoiceGuard(ctx.resolveState,p.employee_id);
   if(guard)return {source:"shift_cost",period:null,agentId:"olivia",...guard};
   const res=await getShiftCost({employeeId:p.employee_id,date:p.date,start:p.start,end:p.end,
    breakMinutes:p.break_minutes??undefined});
   if(!res.ok)return fail("shift_cost",null,res.error);
   const modeled=person&&p.break_minutes!==null&&person.wageCents!==null?
     shiftCost({employeeId:person.id,date:p.date,start:p.start,end:p.end,
       breakMinutes:p.break_minutes,wageCents:person.wageCents}):null;
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
