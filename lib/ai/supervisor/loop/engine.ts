import {createHash} from "node:crypto";
import {z} from "zod";

export type LoopLocale="en"|"es"|"ar";
export type OwnerLoopScope={businessId:string;ownerUserId:string;threadId:string;locale:LoopLocale};
export type ProposalStatus="draft"|"approved"|"committed"|"manual_pending"|
  "manual_confirmed"|"rejected"|"expired";
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
  |{status:"verified";evidenceSource:string};
export type LoopSample={businessDate:string;observation:Record<string,unknown>;source:string};
export type LoopReport={status:"in_progress"|"complete"|"insufficient_evidence";
  result:Record<string,unknown>;recommendation:"keep"|"revert"|"adjust";
  source:string};
export type RegisteredLoopCapability={
  id:string;version:1;
  simulate:(scope:OwnerLoopScope,rawInput:unknown)=>Promise<LoopSimulation>;
  parseEffect:(rawEffect:unknown)=>Record<string,unknown>;
  commit:(scope:OwnerLoopScope,rawEffect:unknown)=>Promise<LoopCommitResult>;
  monitor:(scope:OwnerLoopScope,rawEffect:unknown,businessDate:string)=>Promise<LoopSample|null>;
  report:(scope:OwnerLoopScope,rawEffect:unknown,samples:readonly LoopSample[])=>Promise<LoopReport>;
};
/** Each domain installs typed input/effect schemas; only the commit hook gets
 * effectful authority. The platform never switches on domain capability IDs. */
export function registerLoopCapability<I,E extends Record<string,unknown>>(definition:{
  id:string;version:1;inputSchema:z.ZodType<I>;effectSchema:z.ZodType<E>;
  simulate:(scope:OwnerLoopScope,input:I)=>Promise<LoopSimulation>;
  commit:(scope:OwnerLoopScope,effect:E)=>Promise<LoopCommitResult>;
  monitor:(scope:OwnerLoopScope,effect:E,date:string)=>Promise<LoopSample|null>;
  report:(scope:OwnerLoopScope,effect:E,samples:readonly LoopSample[])=>Promise<LoopReport>;
}):RegisteredLoopCapability{
  if(!/^[a-z][a-z0-9._-]{3,119}$/u.test(definition.id))throw new Error("Invalid capability ID");
  const parse=(raw:unknown):E=>definition.effectSchema.parse(raw);
  return Object.freeze({
    id:definition.id,version:definition.version,
    simulate:async(scope:OwnerLoopScope,raw:unknown)=>{
      const s=await definition.simulate(scope,definition.inputSchema.parse(raw));
      parse(s.effect);
      if(!Number.isSafeInteger(s.monitorSpec.durationDays)||s.monitorSpec.durationDays<1||
        s.monitorSpec.durationDays>90||s.monitorSpec.metricScope.length>160)
        throw new Error("Invalid monitor contract");
      return s;
    },
    parseEffect:(raw:unknown)=>parse(raw),
    commit:(scope:OwnerLoopScope,raw:unknown)=>definition.commit(scope,parse(raw)),
    monitor:(scope:OwnerLoopScope,raw:unknown,date:string)=>definition.monitor(scope,parse(raw),date),
    report:(scope:OwnerLoopScope,raw:unknown,samples:readonly LoopSample[])=>
      definition.report(scope,parse(raw),samples),
  });
}
export function loopRegistry(...definitions:RegisteredLoopCapability[]){
  const map=new Map<string,RegisteredLoopCapability>();
  for(const d of definitions){
    if(map.has(d.id))throw new Error("Duplicate capability registration");
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
  create(scope:OwnerLoopScope,requestKey:string,proposal:LoopCreate):Promise<LoopProposal>;
  load(scope:OwnerLoopScope,id:string):Promise<LoopProposal>;
  transition(scope:OwnerLoopScope,id:string,revision:number,
    action:"approve"|"reject"|"manual_pending"|"manual_confirmed"|"committed",
    startDate?:string):Promise<LoopProposal>;
  addSample(scope:OwnerLoopScope,id:string,sample:LoopSample):Promise<void>;
  samples(scope:OwnerLoopScope,id:string):Promise<LoopSample[]>;
  saveReport(scope:OwnerLoopScope,proposal:LoopProposal,report:LoopReport):Promise<void>;
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
  return repo.create(scope,requestKey,{businessId:scope.businessId,ownerUserId:scope.ownerUserId,
    threadId:scope.threadId,capabilityId:def.id,capabilityVersion:def.version,
    canonicalEffectPayload:validated,effectHash:effectHash(validated),
    baseline:simulation.baseline,monitorSpec:simulation.monitorSpec,locale:scope.locale});
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
  // Only this mode has access to the domain commit hook.
  const result=await def.commit(scope,effect);
  const transition=result.status==="requires_manual_action"?"manual_pending":"committed";
  // For a future connected integration, an independently verified commit
  // starts the same monitoring lifecycle as a manually confirmed effect.
  const start=transition==="committed"?utcDateOffset(new Date().toISOString().slice(0,10),1):undefined;
  const updated=await repo.transition(scope,id,revision,transition,start);
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
export async function monitorLoop(scope:OwnerLoopScope,registry:ReturnType<typeof loopRegistry>,
  repo:LoopRepository,p:LoopProposal,businessDate:string,allowEarlyReport=false):Promise<LoopReport|null>{
  assertProposalScope(scope,p);
  if(!["manual_confirmed","committed"].includes(p.status)||!p.monitoringStartDate)return null;
  const def=registry.get(p.capabilityId);
  if(p.capabilityVersion!==def.version)throw new Error("Monitor contract changed");
  const effect=def.parseEffect(p.canonicalEffectPayload);
  if(effectHash(effect)!==p.effectHash)throw new Error("Monitor effect hash changed");
  const end=utcDateOffset(p.monitoringStartDate,p.monitorSpec.durationDays-1);
  if(businessDate>=p.monitoringStartDate&&businessDate<=end){
    const sample=await def.monitor(scope,effect,businessDate);
    if(sample){
      if(sample.businessDate!==businessDate)throw new Error("Monitor date scope mismatch");
      await repo.addSample(scope,p.id,sample);
    }
  }
  if(!allowEarlyReport&&businessDate<end)return null;
  const samples=(await repo.samples(scope,p.id))
    .filter(x=>x.businessDate>=p.monitoringStartDate!&&x.businessDate<=end);
  const generated=await def.report(scope,effect,samples);
  // "In progress" is a window property, not evidence of a future zero-sales day.
  // At the end, missing actual-coverage observations become a durable
  // insufficient-evidence report rather than an endlessly open experiment.
  const finalStatus=businessDate<end
    ?"in_progress":generated.status==="complete"?"complete":"insufficient_evidence";
  const report:LoopReport={...generated,status:finalStatus,
    recommendation:finalStatus==="complete"?generated.recommendation:"adjust",
    result:{...generated.result,status:finalStatus}};
  await repo.saveReport(scope,p,report);
  return report;
}
