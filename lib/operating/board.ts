/** Operating Board: what the operator is running for the owner and what it
 * reported recently. Built from the Supervisor loop tables only, so the board
 * and the chat describe the same experiments. */

export type BoardProposalRow={
  id:string;thread_id:string;status:string;capability_id:string;
  canonical_effect_payload:unknown;monitor_spec:unknown;monitoring_start_date:string|null;
};
export type BoardReportRow={proposal_id:string;status:string;report:unknown;generated_at:string};

export type BoardRunning={
  proposalId:string;threadId:string;capabilityId:string;productName:string;oldPriceCents:number;newPriceCents:number;
  /** waitingOnOwner: the owner still has to change the price in the POS. */
  stage:"waitingOnOwner"|"monitoring";day:number|null;days:number|null;
  /** Set for goals: productName holds the goal title and the prices are 0. */
  goal?:true;
  /** Existing event-readiness plan, not a price change. */
  event?:true;
};
export type BoardReport={
  proposalId:string;threadId:string;capabilityId:string;productName:string;
  status:"complete"|"insufficient_evidence";recommendation:"keep"|"revert"|"adjust"|null;generatedAt:string;
  /** Goals only: whether the goal was met. */
  goal?:{met:boolean|null};
  event?:true;
};
export type OperatingBoard={running:BoardRunning[];recentReports:BoardReport[]};

/** Rows the board reads; passed to the shared experiment reader. */
export const BOARD_PROPOSAL_STATUSES=["manual_pending","manual_confirmed","committed","monitored"] as const;
export const BOARD_REPORT_STATUSES=["complete","insufficient_evidence"] as const;
/** Only drink price experiments have an experiment panel; every other
 * monitor (a plain price change) opens its chat thread. */
export const DRINK_PRICE_EXPERIMENT_CAPABILITY="alex.drink_price_experiment.v1";
export function boardHref(r:{threadId:string;proposalId:string;capabilityId:string}):string{
  return "/?thread="+encodeURIComponent(r.threadId)+
    (r.capabilityId===DRINK_PRICE_EXPERIMENT_CAPABILITY?"&experiment="+encodeURIComponent(r.proposalId):"");
}
const RECENT_REPORT_DAYS=14;
const MAX_ITEMS=3;

export const GOAL_CAPABILITY="leo.goal.v1";
export const EVENT_CAPABILITY="alex.event_readiness.v1";
function goalTitle(payload:unknown){
  const t=payload&&typeof payload==="object"?(payload as {title?:unknown}).title:null;
  return typeof t==="string"&&t.length>0?t:null;
}
function priceEffect(payload:unknown,capabilityId?:string){
  if(capabilityId===EVENT_CAPABILITY){
    const summary=payload&&typeof payload==="object"?(payload as {summary?:unknown}).summary:null;
    return typeof summary==="string"&&summary.trim()?
      {productName:summary,oldPriceCents:0,newPriceCents:0,event:true as const}:null;
  }
  if(capabilityId===GOAL_CAPABILITY){
    const title=goalTitle(payload);
    return title?{productName:title,oldPriceCents:0,newPriceCents:0,goal:true as const}:null;
  }
  if(!payload||typeof payload!=="object")return null;
  const p=payload as Record<string,unknown>;
  return typeof p.productName==="string"&&Number.isSafeInteger(p.oldPriceCents)&&Number.isSafeInteger(p.newPriceCents)
    ?{productName:p.productName,oldPriceCents:p.oldPriceCents as number,newPriceCents:p.newPriceCents as number}:null;
}
function durationDays(spec:unknown){
  const d=spec&&typeof spec==="object"?(spec as {durationDays?:unknown}).durationDays:null;
  return Number.isSafeInteger(d)&&(d as number)>0?d as number:null;
}
const dayIndex=(from:string,to:string)=>Math.round((Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))/86_400_000)+1;

/** `today` is the café-local date. Newest first; at most three of each. */
export function buildOperatingBoard(proposals:readonly BoardProposalRow[],reports:readonly BoardReportRow[],
  today:string):OperatingBoard{
  const byId=new Map(proposals.map(p=>[p.id,p]));
  const running=proposals.flatMap((p):BoardRunning[]=>{
    const effect=priceEffect(p.canonical_effect_payload,p.capability_id);
    if(!effect)return [];
    if(p.status==="manual_pending")
      return [{proposalId:p.id,threadId:p.thread_id,capabilityId:p.capability_id,...effect,stage:"waitingOnOwner",day:null,days:null}];
    if(!["manual_confirmed","committed"].includes(p.status)||!p.monitoring_start_date)return [];
    const days=durationDays(p.monitor_spec);
    if(days===null)return [];
    const day=dayIndex(p.monitoring_start_date,today);
    // A monitored change with no monitoring window (a plain price change) is not "running".
    if(day>days)return [];
    return [{proposalId:p.id,threadId:p.thread_id,capabilityId:p.capability_id,...effect,stage:"monitoring",day:Math.max(0,day),days}];
  }).slice(0,MAX_ITEMS);
  const cutoff=Date.parse(today+"T00:00:00Z")-RECENT_REPORT_DAYS*86_400_000;
  const recentReports=reports.flatMap((r):BoardReport[]=>{
    const p=byId.get(r.proposal_id);
    const effect=p?priceEffect(p.canonical_effect_payload,p.capability_id):null;
    if(!p||!effect||(r.status!=="complete"&&r.status!=="insufficient_evidence"))return [];
    if(!(Date.parse(r.generated_at)>=cutoff))return [];
    const report=r.report&&typeof r.report==="object"?r.report as {recommendation?:unknown;evaluationStatus?:unknown}:{};
    const rec=report.recommendation;
    return [{proposalId:p.id,threadId:p.thread_id,capabilityId:p.capability_id,productName:effect.productName,status:r.status,
      recommendation:rec==="keep"||rec==="revert"||rec==="adjust"?rec:null,generatedAt:r.generated_at,
      ...("goal" in effect?{goal:{met:report.evaluationStatus==="met"?true:report.evaluationStatus==="missed"?false:null}}:{}),
      ...("event" in effect?{event:true as const}:{})}];
  }).sort((a,b)=>b.generatedAt.localeCompare(a.generatedAt)).slice(0,MAX_ITEMS);
  return {running,recentReports};
}
