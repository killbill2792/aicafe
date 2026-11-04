/** Experiments page: every running and finished Supervisor loop item, with no caps.
 * Built from the same rows and line logic as the Operating Board (board.ts), so the
 * page, the board and the chat describe the same experiments. */
import {monitorDayIndex,reportLines,runningLines,type BoardProposalRow,type BoardReportRow} from "./board";

export type ExperimentSampleRow={proposal_id:string;business_date:string;observation:unknown};
export type ExperimentProposalRow=BoardProposalRow&{baseline:unknown};
export type ExperimentSample={date:string;units:number|null;netSalesCents:number|null;
  coverage:"actual"|"provisional"|"unavailable"};
export type ExperimentVerdict={status:"complete"|"insufficient_evidence";recommendation:"keep"|"revert"|"adjust"|null;
  generatedAt:string;observedRevenueCents:number|null;revenueDifferenceCents:number|null;
  coveredDays:number|null;goalMet:boolean|null};
export type ExperimentEntry={
  proposalId:string;threadId:string;capabilityId:string;title:string;
  kind:"price"|"goal";productId:string|null;oldPriceCents:number|null;newPriceCents:number|null;
  /** waitingOnOwner: POS change not confirmed yet. awaitingReport: window over, report not in. */
  stage:"waitingOnOwner"|"monitoring"|"awaitingReport"|"finished";
  day:number|null;days:number|null;startDate:string|null;endDate:string|null;
  baselineUnits7Days:number|null;estimatedRevenueCents:number|null;
  samples:ExperimentSample[];verdict:ExperimentVerdict|null;
  /** Other running experiments on the same item; their sales would mix. */
  overlapsWith:string[];
};
export type ExperimentsList={running:ExperimentEntry[];past:ExperimentEntry[]};

const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const int=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)?v:null;
const addDays=(day:string,n:number)=>new Date(Date.parse(day+"T00:00:00Z")+n*86_400_000).toISOString().slice(0,10);

export function buildExperimentsList(proposals:readonly ExperimentProposalRow[],reports:readonly BoardReportRow[],
  samples:readonly ExperimentSampleRow[],today:string):ExperimentsList{
  const running=new Map(runningLines(proposals,today).map(line=>[line.proposalId,line]));
  const finished=new Map(reportLines(proposals,reports).map(line=>[line.proposalId,line]));
  const reportById=new Map(reports.map(r=>[r.proposal_id,r]));
  const entries=proposals.flatMap((p):ExperimentEntry[]=>{
    const line=running.get(p.id)??finished.get(p.id);
    const effect=obj(p.canonical_effect_payload),baseline=obj(p.baseline),spec=obj(p.monitor_spec);
    const days=int(spec.durationDays);
    const start=p.monitoring_start_date;
    const end=start&&days?addDays(start,days-1):null;
    // A window that ended without a final report yet is still shown, never dropped.
    const awaiting=!line&&["manual_confirmed","committed"].includes(p.status)&&start&&end&&end<today;
    if(!line&&!awaiting)return [];
    const title=line?line.productName:String(effect.productName??effect.title??"");
    if(!title)return [];
    const goal=line?"goal" in line&&line.goal!==undefined:typeof effect.title==="string";
    const report=finished.has(p.id)?reportById.get(p.id):undefined;
    const result=obj(report?.report);
    const runningLine=running.get(p.id);
    return [{proposalId:p.id,threadId:p.thread_id,capabilityId:p.capability_id,title,
      kind:goal?"goal":"price",productId:typeof effect.productId==="string"?effect.productId:null,
      oldPriceCents:goal?null:int(effect.oldPriceCents),newPriceCents:goal?null:int(effect.newPriceCents),
      stage:runningLine?runningLine.stage:report?"finished":"awaitingReport",
      day:runningLine?.day??(start?Math.min(monitorDayIndex(start,today),days??Infinity):null),days,
      startDate:start,endDate:end,
      baselineUnits7Days:int(effect.baselineUnits7Days),
      estimatedRevenueCents:int(baseline.estimatedAdditionalRevenue7DaysCents),
      samples:samples.filter(s=>s.proposal_id===p.id).map((s):ExperimentSample=>{
        const o=obj(s.observation);
        return {date:s.business_date,units:int(o.units),netSalesCents:int(o.netSalesCents),
          coverage:o.coverage==="actual"?"actual":o.coverage==="provisional"?"provisional":"unavailable"};
      }).sort((a,b)=>a.date.localeCompare(b.date)),
      verdict:report&&(report.status==="complete"||report.status==="insufficient_evidence")?{status:report.status,
        recommendation:finished.get(p.id)?.recommendation??null,generatedAt:report.generated_at,
        observedRevenueCents:int(result.observedRevenueCents),
        revenueDifferenceCents:int(result.realizedRevenueDifferenceCents),
        coveredDays:int(result.coveredDays),goalMet:finished.get(p.id)?.goal?.met??null}:null,
      overlapsWith:[]}];
  });
  const open=entries.filter(e=>e.stage==="waitingOnOwner"||e.stage==="monitoring");
  for(const e of open)e.overlapsWith=open.filter(o=>o!==e&&e.productId&&o.productId===e.productId).map(o=>o.proposalId);
  const byStart=(a:ExperimentEntry,b:ExperimentEntry)=>(b.startDate??"9999").localeCompare(a.startDate??"9999");
  return {running:entries.filter(e=>e.stage!=="finished").sort(byStart),
    past:entries.filter(e=>e.stage==="finished").sort((a,b)=>(b.verdict?.generatedAt??"").localeCompare(a.verdict?.generatedAt??""))};
}
