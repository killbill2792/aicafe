import {z} from "zod";
import {oliviaProposalShifts} from "@/lib/calc/scheduling/oliviaProposalShifts";
import type {AgentToolContext,AgentToolResult} from "./index";
import {nextMonday} from "@/lib/calc/scheduling/weekdayDates";
import {previewOliviaWeek,previewOliviaOwnerSavings} from "@/lib/actions/oliviaPlanning";

const monday=z.iso.date().refine(v=>new Date(v+"T12:00:00Z").getUTCDay()===1,"Must be a Monday");
const schema=z.strictObject({week_start:monday.nullable(),purpose:z.enum(["draft","owner_savings"])});

/** Supervisor is the only conversation entry point; Olivia is the only optimizer.
 * The preview is inert. Existing propose_schedule handles the approval card.
 */
export const draftScheduleTools={draft_week_schedule:{
 agentId:"olivia",schema,
 description:"Use Olivia's canonical scheduler. purpose=draft prepares the next week's roster and ONE existing approval card, so never call propose_schedule after it. purpose=owner_savings models where the unpaid owner could replace paid staff and returns the wage evidence and cost comparison WITHOUT creating a card. Hypothetical owner certification and opportunity costs are not assumed. Never say a preview was published.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const {week_start,purpose}=schema.parse(raw);
  const start=week_start??nextMonday(ctx.asOf);
  if(purpose==="owner_savings"){
   const whatIf=await previewOliviaOwnerSavings({week:start});
   if(!whatIf.ok)return {source:"olivia_owner_what_if",period:{from:start,to:new Date(Date.parse(start+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)},
    missing:[whatIf.error],agentId:"olivia",draft:false,saved:false,approvalTool:"not_created"};
   return {source:"olivia_owner_what_if",period:whatIf.period,agentId:"olivia",
    draft:false,saved:false,approvalTool:"not_created",missing:whatIf.savingsCents===null?
     ["exactSavingsUnavailable"]:[],ownerMinutes:whatIf.ownerMinutes,
    baselineCashWagesCents:whatIf.baselineCashWagesCents,
    withOwnerCashWagesCents:whatIf.withOwnerCashWagesCents,
    savingsCents:whatIf.savingsCents,completeCoverage:whatIf.completeCoverage,
    replacementRows:whatIf.replacementRows,assumptions:whatIf.assumptions,
    warnings:whatIf.warnings,notices:whatIf.notices,locations:whatIf.locations};
  }
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
    ctx.scheduleProposalCreated=approval;
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
