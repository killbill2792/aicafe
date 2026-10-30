import {createHash} from "node:crypto";
import {z} from "zod";
import type {AgentId,OperatingTaskKind,OperatingTask} from "@/lib/operating/tasks";

/** A reused scoped idempotency key must never approve a different effect. */
export class ProposalRequestConflictError extends Error {
  constructor(){super("Conflicting proposal request key");this.name="ProposalRequestConflictError";}
}
import {cafeToday,shiftCafeDate} from "@/lib/metrics/core/clock";
export type LoopLocale="en"|"es"|"ar";
export type OwnerLoopScope={businessId:string;ownerUserId:string;threadId:string;locale:LoopLocale};
export type ProposalStatus="draft"|"approved"|"executing"|"committed"|"manual_pending"|
  "manual_confirmed"|"monitored"|"rejected"|"expired"|"stale";
export type LoopProposal={
  id:string;businessId:string;ownerUserId:string;threadId:string;
  capabilityId:string;capabilityVersion:number;canonicalEffectPayload:unknown;
  effectHash:string;baseline:Record<string,unknown>;
  monitorSpec:{durationDays:number;metricScope:string};
  status:ProposalStatus;revision:number;locale:LoopLocale;
  monitoringStartDate:string|null;createdAt:string;
};
export type LoopSimulation={
  effect:Record<string,unknown>;
  baseline:Record<string,unknown>;
  monitorSpec:{durationDays:number;metricScope:string};
};
export type LoopCommitResult=
  |{status:"requires_manual_action";instructionKey:string;instructions:Record<string,string>}
  |{status:"verified";evidenceSource:string;monitoringStartDate?:string};
/** The monitored days a report covers, first to last (inclusive), and the proposal it is for. */
export type LoopWindow={start:string;through:string;proposalId?:string};
export type LoopSample={businessDate:string;observation:Record<string,unknown>;source:string};
export type LoopReport={status:"in_progress"|"complete"|"insufficient_evidence";
  result:Record<string,unknown>;recommendation:"keep"|"revert"|"adjust";
  source:string;
  /** Short owner message for the one mid-run update; only sent when the
   * monitor asks for it (see monitorLoop's midRun flag). */
  midRunText?:string;
  /** Domain-owned delivery into the existing Operations inbox and owner thread.
   * No platform branch may assume a drink, task kind or specialist identity. */
  delivery?:{
    agentId:AgentId;taskKind:OperatingTaskKind;entityType:string;entityId:string;
    payload:OperatingTask["payload"];confidence:OperatingTask["confidence"];
    evidence:OperatingTask["evidence"];threadText:string;
    /** Verified number offsets from the SAME agent checkNumbers path. */
    numberProvenance?:readonly import("@/lib/ai/agent/checkNumbers").NumberProvenance[];
    numericEvidence?:readonly import("@/lib/ai/agent/checkNumbers").NumericEvidence[];
  };
};
export type RegisteredLoopCapability={
  id:string;version:1|2;proposalInputJsonSchema:unknown;proposalDescription:string;
  simulate:(scope:OwnerLoopScope,rawInput:unknown)=>Promise<LoopSimulation>;
  parseEffect:(rawEffect:unknown)=>Record<string,unknown>;
  dependencyScope:(rawEffect:unknown)=>Record<string,unknown>;
  commit:(scope:OwnerLoopScope,rawEffect:unknown,proposalId?:string)=>Promise<LoopCommitResult>;
  monitor:(scope:OwnerLoopScope,rawEffect:unknown,businessDate:string)=>Promise<LoopSample|null>;
  report:(scope:OwnerLoopScope,rawEffect:unknown,samples:readonly LoopSample[],windowComplete:boolean,window?:LoopWindow)=>Promise<LoopReport>;
  /** Pure owner-intent interpretation and canonical source resolution,
   * never an approval or executable permission from model-authored text. */
  recognizeProposal?:(scope:OwnerLoopScope,currentText:string,
    priorOwnerTexts:readonly string[])=>Promise<unknown|null>;
};
/** Each domain installs typed input/effect schemas; only the commit hook gets
 * effectful authority. The platform never switches on domain capability IDs. */
export function registerLoopCapability<I,E extends Record<string,unknown>>(definition:{
  id:string;version:1|2;inputSchema:z.ZodType<I>;effectSchema:z.ZodType<E>;
  dependencyScope:(effect:E)=>Record<string,unknown>;
  proposalDescription?:string;
  simulate:(scope:OwnerLoopScope,input:I)=>Promise<LoopSimulation>;
  commit:(scope:OwnerLoopScope,effect:E,proposalId?:string)=>Promise<LoopCommitResult>;
  monitor:(scope:OwnerLoopScope,effect:E,date:string)=>Promise<LoopSample|null>;
  report:(scope:OwnerLoopScope,effect:E,samples:readonly LoopSample[],windowComplete:boolean,window?:LoopWindow)=>Promise<LoopReport>;
  recognizeProposal?:(scope:OwnerLoopScope,currentText:string,
    priorOwnerTexts:readonly string[])=>Promise<I|null>;
}):RegisteredLoopCapability{
  if(!/^[a-z][a-z0-9._-]{3,119}$/u.test(definition.id))throw new Error("Invalid capability ID");
  const parse=(raw:unknown):E=>definition.effectSchema.parse(raw);
  return Object.freeze({
    id:definition.id,version:definition.version,
    proposalInputJsonSchema:z.toJSONSchema(definition.inputSchema,{unrepresentable:"any",reused:"inline"}),
    proposalDescription:definition.proposalDescription??"Draft a registered effect for explicit owner review; do not approve or execute.",
    simulate:async(scope:OwnerLoopScope,raw:unknown)=>{
      const s=await definition.simulate(scope,definition.inputSchema.parse(raw));
      parse(s.effect);
      if(!Number.isSafeInteger(s.monitorSpec.durationDays)||s.monitorSpec.durationDays<1||
        s.monitorSpec.durationDays>90||s.monitorSpec.metricScope.length>160)
        throw new Error("Invalid monitor contract");
      return s;
    },
    parseEffect:(raw:unknown)=>parse(raw),
    dependencyScope:(raw:unknown)=>definition.dependencyScope(parse(raw)),
    ...(definition.recognizeProposal?{recognizeProposal:definition.recognizeProposal}:{}),
    commit:(scope:OwnerLoopScope,raw:unknown,proposalId?:string)=>definition.commit(scope,parse(raw),proposalId),
    monitor:(scope:OwnerLoopScope,raw:unknown,date:string)=>definition.monitor(scope,parse(raw),date),
    report:(scope:OwnerLoopScope,raw:unknown,samples:readonly LoopSample[],windowComplete:boolean,window?:LoopWindow)=>
      definition.report(scope,parse(raw),samples,windowComplete,window),
  });
}
export function loopRegistry(...definitions:RegisteredLoopCapability[]){
  const map=new Map<string,RegisteredLoopCapability>();
  for(const d of definitions){
    if(map.has(d.id))throw new Error("Duplicate capability registration");
    if(typeof d.dependencyScope!=="function")throw new Error("Missing dependency scope");
    map.set(d.id,d);
  }
  return Object.freeze({get(id:string){
    const d=map.get(id);
    if(!d)throw new Error("Unregistered effect capability");
    return d;
  },list:()=>[...map.keys()]});
}
export type LoopCreate=Omit<LoopProposal,"id"|"status"|"revision"|"monitoringStartDate"|"createdAt">;
export interface LoopRepository{
  cafeTimezone?:(scope:OwnerLoopScope)=>Promise<string>;
  create(scope:OwnerLoopScope,requestKey:string,proposal:LoopCreate):Promise<LoopProposal>;
  load(scope:OwnerLoopScope,id:string):Promise<LoopProposal>;
  transition(scope:OwnerLoopScope,id:string,revision:number,
    action:"approve"|"reject"|"claim_commit"|"manual_pending"|"manual_confirmed"|"committed"|"finish_monitor",
    startDate?:string):Promise<LoopProposal>;
  addSample(scope:OwnerLoopScope,id:string,sample:LoopSample):Promise<void>;
  clearSample(scope:OwnerLoopScope,id:string,businessDate:string):Promise<void>;
  samples(scope:OwnerLoopScope,id:string):Promise<LoopSample[]>;
  saveReport(scope:OwnerLoopScope,proposal:LoopProposal,report:LoopReport,opts?:{midRun?:boolean}):Promise<void>;
}
/** Canonical content fingerprint; order of JSON object properties must not
 * change the approval's meaning or consume the wrong effect on retry. */
export function effectHash(effect:unknown):string{
  const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):
    v!==null&&typeof v==="object"?
      Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))
        .map(([k,x])=>[k,canonical(x)])):v;
  return createHash("sha256").update(JSON.stringify(canonical(effect))).digest("hex");
}
export function assertProposalScope(scope:OwnerLoopScope,p:LoopProposal):void{
  if(p.businessId!==scope.businessId||p.ownerUserId!==scope.ownerUserId||
    p.threadId!==scope.threadId)throw new Error("Proposal outside authenticated scope");
}
export async function simulateLoop(scope:OwnerLoopScope,registry:ReturnType<typeof loopRegistry>,
  capabilityId:string,input:unknown):Promise<LoopSimulation>{
  return registry.get(capabilityId).simulate(scope,input);
}
export async function proposeLoop(scope:OwnerLoopScope,registry:ReturnType<typeof loopRegistry>,
  repo:LoopRepository,capabilityId:string,input:unknown,requestKey:string):Promise<LoopProposal>{
  const def=registry.get(capabilityId);
  const simulation=await def.simulate(scope,input);
  const validated=def.parseEffect(simulation.effect);
  const dependency=def.dependencyScope(validated);
  if(!dependency||typeof dependency!=="object")throw new Error("Missing dependency scope");
  return repo.create(scope,requestKey,{businessId:scope.businessId,ownerUserId:scope.ownerUserId,
    threadId:scope.threadId,capabilityId:def.id,capabilityVersion:def.version,
    canonicalEffectPayload:validated,effectHash:effectHash(validated),
    baseline:simulation.baseline,monitorSpec:simulation.monitorSpec,locale:scope.locale});
}
/** Owner text can request an INERT proposal, not approval or commit. A
 * capability owns its domain interpretation, and the shared planner rejects
 * ambiguous matches instead of guessing which effect the owner intended. */
export async function proposeFromOwnerConversation(scope:OwnerLoopScope,
  registry:ReturnType<typeof loopRegistry>,repo:LoopRepository,
  currentText:string,priorOwnerTexts:readonly string[],requestKey:string):
  Promise<LoopProposal|null>{
  const candidates:Array<{capabilityId:string;input:unknown}>=[];
  for(const id of registry.list()){
    const match=await registry.get(id).recognizeProposal?.(scope,currentText,priorOwnerTexts);
    if(match!==undefined&&match!==null)candidates.push({capabilityId:id,input:match});
  }
  if(candidates.length!==1)return null;
  return proposeLoop(scope,registry,repo,candidates[0].capabilityId,
    candidates[0].input,requestKey);
}
export async function approveLoop(scope:OwnerLoopScope,repo:LoopRepository,id:string,revision:number){
  const p=await repo.load(scope,id);assertProposalScope(scope,p);
  if(p.revision!==revision||p.status!=="draft")throw new Error("Proposal approval conflict");
  return repo.transition(scope,id,revision,"approve");
}
export async function commitLoop(scope:OwnerLoopScope,registry:ReturnType<typeof loopRegistry>,
  repo:LoopRepository,id:string,revision:number):Promise<{proposal:LoopProposal;result:LoopCommitResult}>{
  const p=await repo.load(scope,id);assertProposalScope(scope,p);
  if(p.revision!==revision||p.status!=="approved")throw new Error("Approval required");
  const def=registry.get(p.capabilityId);
  if(p.capabilityVersion!==def.version)throw new Error("Effect contract version changed");
  const effect=def.parseEffect(p.canonicalEffectPayload);
  if(p.effectHash!==effectHash(effect))throw new Error("Immutable effect changed");
  // Resolve the authenticated café calendar BEFORE committing a side effect.
  // A missing timezone must never execute an irreversible effect and fail afterward.
  const timezone=await repo.cafeTimezone?.(scope);
  if(!timezone)throw new Error("Café timezone required for commit");
  const committedDate=cafeToday(timezone);
  // Claim the exact approval under the repository's atomic revision lock
  // BEFORE invoking a domain effect. A competing call never reaches commit.
  // A failed effect deliberately remains "executing" for reconciliation:
  // automatic retries must never invoke a potentially irreversible action twice.
  const claimed=await repo.transition(scope,id,revision,"claim_commit");
  if(claimed.status!=="executing"||claimed.revision!==revision+1||
    claimed.effectHash!==p.effectHash)throw new Error("Approval claim invalid");
  // Only this mode has access to the domain commit hook.
  const result=await def.commit(scope,effect,id);
  const transition=result.status==="requires_manual_action"?"manual_pending":"committed";
  // For a future connected integration, a verified commit starts a monitor
  // window. The manual POS workflow uses the café-local confirmed date.
  const start=transition==="committed"?(result.status==="verified"?result.monitoringStartDate:undefined)??shiftCafeDate(committedDate,1):undefined;
  if(start&&utcDateOffset(start,0)!==start)throw new Error("Invalid monitor start date");
  const updated=await repo.transition(scope,id,claimed.revision,transition,start);
  return {proposal:updated,result};
}
export async function confirmManualLoop(scope:OwnerLoopScope,repo:LoopRepository,
  id:string,revision:number,monitorStartDate:string):Promise<LoopProposal>{
  const p=await repo.load(scope,id);assertProposalScope(scope,p);
  if(p.revision!==revision||p.status!=="manual_pending")throw new Error("Manual handoff required");
  return repo.transition(scope,id,revision,"manual_confirmed",monitorStartDate);
}
export function utcDateOffset(day:string,n:number):string{
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(day)||!Number.isSafeInteger(n))throw new Error("Invalid day");
  const date=new Date(day+"T00:00:00.000Z");
  if(Number.isNaN(date.valueOf())||date.toISOString().slice(0,10)!==day)
    throw new Error("Invalid date");
  date.setUTCDate(date.getUTCDate()+n);
  return date.toISOString().slice(0,10);
}
/** The business day after which the one mid-run update is sent: the end of the
 * first half of the window (day 3 of 7). */
export function midRunDay(start:string,durationDays:number):string{
  return utcDateOffset(start,Math.max(1,Math.floor(durationDays/2))-1);
}
export async function monitorLoop(scope:OwnerLoopScope,registry:ReturnType<typeof loopRegistry>,
  repo:LoopRepository,p:LoopProposal,businessDate:string,allowEarlyReport=false,
  midRun=false):Promise<LoopReport|null>{
  assertProposalScope(scope,p);
  if(!["manual_confirmed","committed"].includes(p.status)||!p.monitoringStartDate)return null;
  // The proposal captured the owner locale when created. Subsequent cron/API
  // calls must not overwrite it with a default English request scope.
  const reportScope:OwnerLoopScope={...scope,locale:p.locale};
  const def=registry.get(p.capabilityId);
  if(p.capabilityVersion!==def.version)throw new Error("Monitor contract changed");
  const effect=def.parseEffect(p.canonicalEffectPayload);
  if(effectHash(effect)!==p.effectHash)throw new Error("Monitor effect hash changed");
  const end=utcDateOffset(p.monitoringStartDate,p.monitorSpec.durationDays-1);
  if(businessDate>=p.monitoringStartDate&&businessDate<=end){
    const sample=await def.monitor(reportScope,effect,businessDate);
    if(sample){
      if(sample.businessDate!==businessDate)throw new Error("Monitor date scope mismatch");
      await repo.addSample(scope,p.id,sample);
    }else{
      // A corrected POS sync can revoke an earlier day's "actual" coverage.
      // Never preserve a stale sample and call a now-incomplete period complete.
      await repo.clearSample(scope,p.id,businessDate);
    }
  }
  if(!allowEarlyReport&&businessDate<end)return null;
  const samples=(await repo.samples(scope,p.id))
    .filter(x=>x.businessDate>=p.monitoringStartDate!&&x.businessDate<=end);
  // The days the report covers: every one counts, sampled or not.
  const generated=await def.report(reportScope,effect,samples,businessDate>=end,
    {start:p.monitoringStartDate,through:businessDate<end?businessDate:end,proposalId:p.id});
  // "In progress" is a window property, not evidence of a future zero-sales day.
  // At the end, missing actual-coverage observations become a durable
  // insufficient-evidence report rather than an endlessly open experiment.
  const finalStatus=businessDate<end
    ?"in_progress":generated.status==="complete"?"complete":"insufficient_evidence";
  const report:LoopReport={...generated,status:finalStatus,
    recommendation:finalStatus==="complete"?generated.recommendation:"adjust",
    result:{...generated.result,status:finalStatus}};
  await repo.saveReport(reportScope,p,report,{midRun:midRun&&finalStatus==="in_progress"});
  return report;
}
