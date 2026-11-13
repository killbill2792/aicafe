import {z} from "zod";
import {oliviaProposalShifts} from "@/lib/calc/scheduling/oliviaProposalShifts";
import type {AgentToolContext,AgentToolResult} from "./index";
import {nextMonday} from "@/lib/scheduling/staffScheduleLinks";
import {previewOliviaWeek,previewOliviaOwnerSavings} from "@/lib/actions/oliviaPlanning";

const monday=z.iso.date().refine(v=>new Date(v+"T12:00:00Z").getUTCDay()===1,"Must be a Monday");
const schema=z.strictObject({week_start:monday.nullable(),purpose:z.enum(["draft","owner_savings"])});

/** Supervisor is the only conversation entry point; Olivia is the only optimizer.
 * The preview is inert. Existing propose_schedule handles the approval card.
 */
export const draftScheduleTools={draft_week_schedule:{
 agentId:"olivia",schema,
 description:"Understand owner scheduling requests naturally; use the one existing Olivia optimizer. purpose=draft prepares the roster and ONE existing approval card, so never call propose_schedule again. A request to change employee availability or a scheduling rule first requires its existing propose_availability_change or propose_rule_change tool; don't pretend an unapproved change was used in the roster. Return scenario costs, gaps and source limitations so the owner can ask 'why', 'what if' or 'make it cheaper' without invented arithmetic. purpose=owner_savings models an unpaid owner alternative WITHOUT a card. Never claim a draft was published, accepted by workers, or sent.",
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
  const canPropose=result.plan.status==="feasible"&&best.completeCoverage!==false&&
   best.hardConstraintsSatisfied!==false&&proposedShifts.length>0&&proposedShifts.length<=60&&
   proposedShifts.every(s=>s.break_minutes<=240&&s.start!==s.end);
  let approval: {proposalId:string;revision:number;capabilityId:string}|null=null;
  let approvalError:string|null=null;
  if(canPropose&&ctx.scheduleProposalCreated)approval=ctx.scheduleProposalCreated;
  else if(canPropose&&ctx.proposals?.proposeStaff){
   try {
    // The existing authorized proposal writer creates ONE inert owner card.
    // Only the owner's approval click may write dated draft shifts.
    approval=await ctx.proposals.proposeStaff({name:"propose_schedule",
     input:{week_start:start,shifts:proposedShifts}});
    ctx.scheduleProposalCreated=approval;
   }catch{approvalError="approvalProposalUnavailable";}
  }
  // The hourly rollup groups orders by their CLOSE hour, not customer arrival.
  // This is observed comparable history, never an inferred worker count.
  const demand=result.demandEvidence;
  const demandSummary=demand?{
   status:demand.status,source:demand.source,basis:demand.basis,
   historicalPeriod:demand.historicalPeriod,readAt:demand.readAt,
   sourceUpdatedAt:demand.sourceUpdatedAt,
   availableComparableHours:demand.totalComparableHours,
   returnedComparableHours:demand.hours.length,truncated:demand.truncated,
   // Keep the full comparable count while bounding model input tokens.
   sampledHours:demand.hours.slice().sort((a,b)=>
     b.observedAverageOrders-a.observedAverageOrders||
     a.targetDate.localeCompare(b.targetDate)||a.hourLocal-b.hourLocal).slice(0,30),
   missing:demand.missing,
   note:"Historical order close-hour observations only; not a customer arrival forecast or an automatic staffing requirement",
  }:null;
  // The solver supplies exact comparable scenarios, not the language model.
  // Null costs remain unknown; two alternatives need not be globally optimal.
  const alternatives=(result.plan.scenarios??[]).slice(0,3).map(scenario=>({
   objective:scenario.objective,staffShiftCount:scenario.shifts.length,
   completeCoverage:scenario.completeCoverage,hardConstraintsSatisfied:scenario.hardConstraintsSatisfied,
   gapCount:scenario.gaps.length,ownerMinutes:scenario.ownerMinutes,
   cashWagesCents:scenario.cost.cashWagesCents,
   loadedPayrollCents:scenario.cost.loadedPayrollCents,
   costState:scenario.cost.costState,
   missingWageEmployeeIds:scenario.cost.missingWageEmployeeIds,
   legalReview:scenario.legalReview,
  }));
  return {source:"olivia_schedule",period:{from:start,to:result.plan.horizonEnd},
   agentId:"olivia",draft:true,saved:false,
   missing:[...result.notices.map(n=>n.code),
    ...(demand?.missing??[]),
    ...(approvalError?[approvalError]:[]),
    ...(!canPropose?["approvalShiftLimitOrInvalidShift"]:[])],
   plannerStatus:result.plan.status,completeCoverage:best.completeCoverage,
   demandEvidence:demandSummary,
   laborCost:best.cost,gaps:best.gaps,warnings:result.plan.warnings,
   scenarioAlternatives:alternatives,solverProof:result.plan.proof,
   explanationScope:"Based on owner-confirmed coverage and recorded availability; POS close-hour history is informational, not an inferred staffing requirement; scheduled wages are not actual payroll",
   proposedShifts,
   proposedShiftCount:proposedShifts.length,
   proposalReady:canPropose, ...(approval??{}),
   approvalTool:approval?"existing_card_created":"not_created",weekStart:start};
 }
}} as const;
