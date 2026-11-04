import {z} from "zod";
import {formatInTimeZone} from "date-fns-tz";
import type {AgentToolContext,AgentToolResult} from "./index";
import {nextMonday} from "@/lib/calc/scheduling/draftWeek";
import {previewOliviaWeek} from "@/lib/actions/oliviaPlanning";

const monday=z.iso.date().refine(v=>new Date(v+"T12:00:00Z").getUTCDay()===1,"Must be a Monday");
const schema=z.strictObject({week_start:monday.nullable()});

/** Supervisor is the only conversation entry point; Olivia is the only optimizer.
 * The preview is inert. Existing propose_schedule handles the approval card.
 */
export const draftScheduleTools={draft_week_schedule:{
 agentId:"olivia",schema,
 description:"Use Olivia's canonical rules-aware planner to preview next week's staff roster. Returns a draft only; when the owner wants to apply it, pass the returned proposedShifts to propose_schedule for ONE owner approval card. Never say a preview was saved or published.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const {week_start}=schema.parse(raw);
  const start=week_start??nextMonday(ctx.asOf);
  const result=await previewOliviaWeek({week:start});
  if(!result.ok)return {source:"olivia_schedule",period:{from:start,to:new Date(Date.parse(start+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)},
   agentId:"olivia",draft:true,saved:false,missing:[result.error,...(result.blockers??[]).map(b=>b.code)]};
  const best=result.plan.best;
  if(!best)return {source:"olivia_schedule",period:null,agentId:"olivia",draft:true,saved:false,missing:["noPlannerScenario"]};
  const proposedShifts=best.shifts.map(shift=>{
   const zone=result.locations[shift.locationId];
   const localDate=formatInTimeZone(new Date(shift.startAt),zone,"yyyy-MM-dd");
   const startLocal=formatInTimeZone(new Date(shift.startAt),zone,"HH:mm");
   const endLocal=formatInTimeZone(new Date(shift.endAt),zone,"HH:mm");
   const duration=Math.round((Date.parse(shift.endAt)-Date.parse(shift.startAt))/60000);
   const breakMinutes=Math.max(0,duration-shift.paidMinutes);
   return {employee_id:shift.employeeId,date:localDate,start:startLocal,end:endLocal,
    break_minutes:breakMinutes};
  });
  return {source:"olivia_schedule",period:{from:start,to:result.plan.horizonEnd},
   agentId:"olivia",draft:true,saved:false,missing:result.notices.map(n=>n.code),
   plannerStatus:result.plan.status,completeCoverage:best.completeCoverage,
   laborCost:best.cost,gaps:best.gaps,warnings:result.plan.warnings,
   proposedShifts:proposedShifts.slice(0,60),
   ...(proposedShifts.length>60?{missing:["approvalShiftLimit"],proposalReady:false}:{proposalReady:true}),
   approvalTool:"propose_schedule",weekStart:start};
 }
}} as const;
