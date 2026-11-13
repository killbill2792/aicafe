import {z} from "zod";
import {oliviaProposalShifts} from "@/lib/calc/scheduling/oliviaProposalShifts";
import type {AgentToolContext,AgentToolResult} from "./index";
import {nextMonday} from "@/lib/scheduling/staffScheduleLinks";
import {previewOliviaWeek,previewOliviaOwnerSavings,previewOliviaAbsenceWhatIf} from "@/lib/actions/oliviaPlanning";

const monday=z.iso.date().refine(v=>new Date(v+"T12:00:00Z").getUTCDay()===1,"Must be a Monday");
const schema=z.strictObject({week_start:monday.nullable(),purpose:z.enum([
 "draft","owner_savings","cash_cost","owner_time","balanced",
 "compare_only","cash_preview","owner_time_preview",
])});
const absenceSchema=z.strictObject({week_start:monday.nullable(),
 employee_name:z.string().trim().min(1).max(80),
 weekday:z.number().int().min(0).max(6)});
const selectedObjectiveLabel=(objective:"cash"|"owner_time"|"balanced"|null)=>objective??"default";

/** Supervisor is the only conversation entry point; Olivia is the only optimizer.
 * The preview is inert. Existing propose_schedule handles the approval card.
 */
export const draftScheduleTools={draft_week_schedule:{
 agentId:"olivia",schema,
 description:"Use the one Olivia optimizer for natural staffing instructions. draft makes a full proposed roster; cash_cost asks for the low modeled cash-wage candidate (not guaranteed global minimum); owner_time asks for fewer owner-shift minutes; balanced uses the balanced candidate. These create ONE inert owner card only if all required coverage is feasible. For 'what if', 'compare', 'explain cost' or 'show me the cheaper option first', use compare_only, cash_preview or owner_time_preview: they NEVER create a card. owner_savings is another read-only what-if. For 'what if Sarah is off Tuesday' use simulate_staff_absence, not saved availability edits. Actual saved availability/rule changes use the existing propose_availability_change/propose_rule_change gateway. Do not claim saved, published, messaged, or guaranteed demand prediction.",
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
  // The requested business objective chooses among already-validated
  // deterministic solver candidates; a missing/infeasible alternative may
  // not override a valid default schedule.
  const requestedObjective=purpose==="cash_cost"||purpose==="cash_preview"?"cash":
   purpose==="owner_time"||purpose==="owner_time_preview"?"owner_time":
   purpose==="balanced"?"balanced":null;
  const previewOnly=["compare_only","cash_preview","owner_time_preview"].includes(purpose);
  const requestedCandidate=requestedObjective?
   result.plan.scenarios?.find(s=>s.objective===requestedObjective&&
     s.completeCoverage&&s.hardConstraintsSatisfied):null;
  const best=requestedCandidate??result.plan.best;
  if(!best)return {source:"olivia_schedule",period:null,agentId:"olivia",draft:true,saved:false,missing:["noPlannerScenario"]};
  const proposedShifts=oliviaProposalShifts(best.shifts,result.locations);
  const canPropose=result.plan.status==="feasible"&&best.completeCoverage!==false&&
   best.hardConstraintsSatisfied!==false&&proposedShifts.length>0&&proposedShifts.length<=60&&
   proposedShifts.every(s=>s.break_minutes<=240&&s.start!==s.end);
  let approval: {proposalId:string;revision:number;capabilityId:string}|null=null;
  let approvalError:string|null=null;
  if(!previewOnly&&canPropose&&ctx.scheduleProposalCreated)approval=ctx.scheduleProposalCreated;
  else if(!previewOnly&&canPropose&&ctx.proposals?.proposeStaff){
   try {
    // The existing authorized proposal writer creates ONE inert owner card.
    // Only the owner's approval click may write dated draft shifts.
    approval=await ctx.proposals.proposeStaff({name:"propose_schedule",
     input:{week_start:start,shifts:proposedShifts}});
    ctx.scheduleProposalCreated=approval;
   }catch{approvalError="approvalProposalUnavailable";}
  }
  if(!previewOnly&&canPropose&&!approval&&!approvalError&&!ctx.proposals?.proposeStaff)
   approvalError="approvalProposalUnavailable";
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
    ...(!canPropose&&!previewOnly?["approvalShiftLimitOrInvalidShift"]:[])],
   plannerStatus:result.plan.status,completeCoverage:best.completeCoverage,
   demandEvidence:demandSummary,
   laborCost:best.cost,gaps:best.gaps,warnings:result.plan.warnings,
   scenarioAlternatives:alternatives,solverProof:result.plan.proof,
   requestedObjective:selectedObjectiveLabel(requestedObjective),
   selectedObjective:best.objective,
   requestedObjectiveMet:requestedObjective===null||best.objective===requestedObjective,
   explanationScope:"Based on owner-confirmed coverage and recorded availability; POS close-hour history is informational, not an inferred staffing requirement; scheduled wages are not actual payroll",
   proposedShifts,
   proposedShiftCount:proposedShifts.length,
   proposalReady:canPropose&&!previewOnly,previewOnly, ...(approval??{}),
   approvalTool:approval?"existing_card_created":"not_created",weekStart:start};
 }
 },
 simulate_staff_absence:{
  agentId:"olivia",schema:absenceSchema,
  description:"Answer a read-only hypothetical like 'What if Sarah cannot work Tuesday next week?' using the same verified Olivia scheduling solver, without saving anything or creating a proposal card. week_start=null means next business-local week. employee_name is the owner's actual name or unique first name; weekday is Sunday=0 through Saturday=6. Ambiguous/missing employees are reported rather than guessed. If the owner explicitly asks to SAVE an absence, use existing propose_availability_change instead.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const {week_start,employee_name,weekday}=absenceSchema.parse(raw);
   const week=week_start??nextMonday(ctx.asOf);
   const selectedEmployeeIds=[...(ctx.resolveState?.chosenIds??[])]
     .filter(id=>z.uuid().safeParse(id).success).slice(0,10);
   const result=await previewOliviaAbsenceWhatIf({
     week,employeeName:employee_name,weekday,selectedEmployeeIds});
   if(!result.ok)return {source:"olivia_hypothetical_absence",
    agentId:"olivia",period:null,draft:false,saved:false,
    missing:[result.error],...(result.error==="employee_ambiguous"?{
     needsOwnerChoice:true,candidates:result.candidates?.map(e=>({
      id:e.id,label:e.name,detail:"Team member • record "+e.id.slice(-6),
     }))??[],
    }:{})};
   return {source:"olivia_hypothetical_absence",agentId:"olivia",
    period:result.period,draft:false,saved:false,missing:[],
    hypothetical:true,employeeName:result.employeeName,
    absentDate:result.absentDate,
    baseline:result.baseline,alternative:result.alternative,
    changeInModeledCashWagesCents:result.changeInModeledCashWagesCents,
    rosterChanges:result.rosterChanges,
    laborCostDifferenceKnown:result.laborCostDifferenceKnown,
    comparisonCompleteCoverage:result.comparisonCompleteCoverage,
    assumptions:result.assumptions,warnings:result.warnings,
    note:"Read-only owner hypothetical; employee availability and published rosters are unchanged",
   };
  },
 }
} as const;