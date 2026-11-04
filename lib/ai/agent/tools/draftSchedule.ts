import {z} from "zod";
import {oliviaProposalShifts} from "@/lib/calc/scheduling/oliviaProposalShifts";
import type {AgentToolContext,AgentToolResult} from "./index";
import {nextMonday} from "@/lib/calc/scheduling/weekdayDates";
import {previewOliviaWeek} from "@/lib/actions/oliviaPlanning";

const monday=z.iso.date().refine(v=>new Date(v+"T12:00:00Z").getUTCDay()===1,"Must be a Monday");
const schema=z.strictObject({week_start:monday.nullable()});

/** Supervisor is the only conversation entry point; Olivia is the only optimizer.
 * The preview is inert. Existing propose_schedule handles the approval card.
 */
export const draftScheduleTools={draft_week_schedule:{
 agentId:"olivia",schema,
 description:"Use Olivia's canonical rules-aware planner to preview next week's staff roster. Creates ONE owner approval card for a schedule request itself. Never call propose_schedule again after this tool. Never say a preview was saved or published.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const {week_start}=schema.parse(raw);
  const start=week_start??nextMonday(ctx.asOf);
  const result=await previewOliviaWeek({week:start});
  if(!result.ok)return {source:"olivia_schedule",period:{from:start,to:new Date(Date.parse(start+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)},
   agentId:"olivia",draft:true,saved:false,missing:[result.error,...(result.blockers??[]).map(b=>b.code)]};
  const best=result.plan.best;
  if(!best)return {source:"olivia_schedule",period:null,agentId:"olivia",draft:true,saved:false,missing:["noPlannerScenario"]};
  const proposedShifts=oliviaProposalShifts(best.shifts,result.locations);
  const canPropose=proposedShifts.length>0&&proposedShifts.length<=60&&
   proposedShifts.every(s=>s.break_minutes<=240&&s.start!==s.end);
  let approval: {proposalId:string;revision:number;capabilityId:string}|null=null;
  let approvalError:string|null=null;
  if(canPropose&&ctx.proposals?.proposeStaff){
   try {
    // The existing authorized proposal writer creates ONE inert owner card.
    // Only the owner's approval click may write dated draft shifts.
    approval=await ctx.proposals.proposeStaff({name:"propose_schedule",
     input:{week_start:start,shifts:proposedShifts}});
   }catch{approvalError="approvalProposalUnavailable";}
  }
  return {source:"olivia_schedule",period:{from:start,to:result.plan.horizonEnd},
   agentId:"olivia",draft:true,saved:false,
   missing:[...result.notices.map(n=>n.code),...(approvalError?[approvalError]:[]),
    ...(!canPropose?["approvalShiftLimitOrInvalidShift"]:[])],
   plannerStatus:result.plan.status,completeCoverage:best.completeCoverage,
   laborCost:best.cost,gaps:best.gaps,warnings:result.plan.warnings,
   proposedShifts,
   proposedShiftCount:proposedShifts.length,
   proposalReady:canPropose, ...(approval??{}),
   approvalTool:approval?"existing_card_created":"not_created",weekStart:start};
 }
}} as const;
