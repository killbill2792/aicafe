import {z} from "zod";
import {getTeam,getWeekSchedule,getCoverageGaps,getShiftCost} from "@/lib/actions/schedule";
import {getTeamRules} from "@/lib/actions/teamRules";
import {staffReadScope,mondayOfLocalDate} from "@/lib/scheduling/staffScope.server";
import type {AgentToolContext,AgentToolResult} from "./index";
const week=z.strictObject({week_start:z.iso.date().nullable()});
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
  agentId:"olivia",schema:week,
  description:"Read active team, individual weekly hours and wage estimate flags. Pass week_start as YYYY-MM-DD Monday or null for this business week.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=week.parse(raw),ws=await localWeek(input.week_start,ctx);
   const result=await getTeam({weekStart:ws});
   if(!result.ok)return fail("staff_week",null,result.error);
   const people=result.data.team.slice(0,30),shifts=result.data.shifts.slice(0,30);
   return {source:"employees+scheduled_shifts",period:{from:ws,to:new Date(Date.parse(ws+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)},
    agentId:"olivia",missing:[...(result.data.team.length>30?["morePeople"]:[]),
     ...(result.data.shifts.length>30?["moreShifts"]:[])],estimated:result.data.totals.estimated,
    people:people.map(p=>({id:p.id,name:p.name,role:p.role,minWeeklyMinutes:p.minWeeklyMinutes,
      maxWeeklyMinutes:p.maxWeeklyMinutes,hasKnownWage:p.wageCents!==null})),
    shifts:shifts.map(s=>({employeeId:s.employeeId,date:s.date,paidMinutes:s.paidMinutes,
      costCents:s.costCents,estimated:s.estimated})),
    weeklyPaidMinutes:result.data.totals.paidMinutes,knownWagesCents:result.data.totals.knownCostCents,
    missingWageCount:result.data.totals.unknownCount};
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
       ...(data.total.unknownCount?["wagesUnknownForSomeShifts"]:[])],
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
    agentId:"olivia",missing:[...(whole.data.openHours?[]:["openHoursNotConfigured"]),
      ...(gaps.data.gaps.length>30?["moreGaps"]:[])],estimated:false,gaps:gaps.data.gaps.slice(0,30)};
  }
 },
 get_shift_cost:{
  agentId:"olivia",schema:estimate,
  description:"Calculate an uncommitted shift's paid minutes and wages from the same deterministic cost engine used by the shift sheet; missing wage is estimated or unknown.",
  execute:async(raw:unknown):Promise<AgentToolResult>=>{
   const p=estimate.parse(raw);
   const res=await getShiftCost({employeeId:p.employee_id,date:p.date,start:p.start,end:p.end,
    breakMinutes:p.break_minutes??undefined});
   if(!res.ok)return fail("shift_cost",null,res.error);
   return {source:"employees+shiftCost",period:{from:p.date,to:p.date},
    agentId:"olivia",missing:res.data.unknown?["wageAndEstimateMissing"]:[],
    estimated:res.data.estimated,unknown:res.data.unknown,
    employeeId:res.data.employeeId,paidMinutes:res.data.paidMinutes,costCents:res.data.costCents};
  }
 }
} as const;
