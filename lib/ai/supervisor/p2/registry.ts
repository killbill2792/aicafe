import { createHash } from "node:crypto";
import { z } from "zod";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";

/** P2 is an isolated, read-only shadow protocol. No production router imports this module. */
export const CAPABILITY_MODES = ["read", "simulate", "evaluate", "propose", "approve", "commit"] as const;
export type CapabilityMode = (typeof CAPABILITY_MODES)[number];
export type ResultStatus = "verified" | "estimated" | "partial" | "unavailable" |
  "insufficient_evidence" | "requires_approval" | "conflict" | "failed";

export type TrustedReadScope = {
  /** Constructed only after the P1 owner/membership/selected-business checks. */
  role: "owner";
  businessId: string;
  identity: { businessId?: string; asOf: string; timezone: string; currency?: string };
  tools: BusinessScopedCafeTools;
  shadowEnabled: boolean;
  /** Audited owner-authored clause, injected by the caller, never model input. */
  ownerClause?: string;
  /** Same-thread owner-authored context; never model summaries or grants. */
  ownerContext?: string;
  /** Trusted snapshot readiness; independent domain readers may omit money fields. */
  financialReadsAvailable?:boolean;
};
type Limits = Readonly<{
  maxOperations: number; timeoutMs: number; maxResultBytes: number;
  maxInputBytes: number; maxRangeDays: number;
}>;
type Base<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  readonly id: string; readonly version: 1; readonly owner: string;
  readonly purpose: string; readonly sourceIds: readonly string[];
  /** Exact canonical reader IDs permitted to attest this capability's source. */
  readonly canonicalReaderIds: readonly string[];
  readonly allowedPurposes: readonly string[];
  readonly inputSchema: I; readonly outputSchema: O;
  readonly schemaContract: Readonly<{
    id: string; registrationId:string; version: 1; inputSchemaFingerprint: string; outputSchemaFingerprint: string;
  }>;
  readonly requiredRole: "owner"; readonly sensitivity: "normal" | "staff" | "financial";
  readonly budgets: Limits;
  readonly requiresApproval: boolean;
  readonly effectPolicy: "deny";
  /** Domain-owned declaration: this read computes an owner-parameterized scenario. */
  readonly resultKind?: "owner_parameterized_simulation";
  /** Domain-owned output policy, never a question/intent route. Defaults to USD_only. */
  readonly currencyPolicy?:"independent"|"USD_only";
};
export type ReadRegistration<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> =
  Base<I,O> & { readonly mode: "read"; readonly availability: "shadow";
    readonly read: (scope:TrustedReadScope,input:z.output<I>)=>Promise<unknown>;
    readonly simulate?:never; readonly evaluate?:never; readonly propose?:never;
    readonly approve?:never; readonly commit?:never;
  };
/** The other five modes have distinct type identities but NO executable handlers in P2.
 * Proposal and effect transitions are intentionally reserved for P4.
 */
type Inert<M extends Exclude<CapabilityMode,"read"|"simulate">> = Base & {
  readonly mode:M; readonly availability:"disabled";
  readonly read?:never; readonly simulate?:never; readonly evaluate?:never;
  readonly propose?:never; readonly approve?:never; readonly commit?:never;
};
/** P3 extends only the read-only simulate mode. P4 effects remain disabled. */
export type SimulateRegistration<I extends z.ZodType=z.ZodType,O extends z.ZodType=z.ZodType> =
  Base<I,O> & {
    readonly mode:"simulate";readonly availability:"shadow"|"disabled";
    readonly read?:never;readonly evaluate?:never;readonly propose?:never;
    readonly approve?:never;readonly commit?:never;
    readonly simulate?:(scope:TrustedReadScope,input:z.output<I>,
      trustedSourceContext:unknown)=>Promise<unknown>|unknown;
  };
export type EvaluateRegistration=Inert<"evaluate">;
export type ProposeRegistration=Inert<"propose">;
export type ApproveRegistration=Inert<"approve">;
export type CommitRegistration=Inert<"commit">;
export type P2Registration=ReadRegistration | SimulateRegistration | EvaluateRegistration |
  ProposeRegistration | ApproveRegistration | CommitRegistration;

export const unavailable = (reason:string) => ({
  status:"unavailable" as const,value:null,reason,
});

export function schemaFingerprint(schema:z.ZodType):string {
  return createHash("sha256").update(JSON.stringify(
    z.toJSONSchema(schema,{unrepresentable:"any",reused:"inline"}),
  )).digest("hex");
}

/** Non-strict Zod objects can silently strip unreviewed output fields.
 * Compare the raw reader shape against the parsed value recursively to reject
 * discarded effect, approval or other unknown fields before trusting evidence.
 */
function discardedOutputKeys(raw:unknown,parsed:unknown):boolean {
  if(Array.isArray(raw))return !Array.isArray(parsed) ||
    raw.length!==parsed.length || raw.some((x,i)=>discardedOutputKeys(x,parsed[i]));
  if(raw!==null && typeof raw==="object"){
    if(parsed===null || typeof parsed!=="object" || Array.isArray(parsed))return true;
    const output=parsed as Record<string,unknown>;
    const original=raw as Record<string,unknown>;
    return Object.keys(original).length!==Object.keys(output).length ||
      Object.entries(original).some(([key,value])=>
        !Object.hasOwn(output,key) || discardedOutputKeys(value,output[key]));
  }
  // No Zod coercion/transformation of authoritative scalar evidence.
  return !Object.is(raw,parsed);
}

function validateRegistration(def:P2Registration) {
  if(!/^[a-z][a-z0-9._-]{2,120}$/.test(def.id) || def.version!==1 ||
    !CAPABILITY_MODES.includes(def.mode) || !def.owner || !def.purpose ||
    !Array.isArray(def.sourceIds) || !def.sourceIds.length ||
    !Array.isArray(def.canonicalReaderIds) || !def.canonicalReaderIds.length ||
    def.canonicalReaderIds.some(id=>typeof id!=="string"||!id.trim()) ||
    !Array.isArray(def.allowedPurposes) || !def.allowedPurposes.length ||
    def.requiredRole!=="owner" || def.effectPolicy!=="deny" ||
    (def.mode==="read" && (def.availability!=="shadow" || typeof def.read!=="function")) ||
    (def.mode==="simulate" && (
      (def.availability==="shadow" && typeof def.simulate!=="function") ||
      (def.availability==="disabled" && "simulate" in def))) ||
    (def.mode!=="read" && def.mode!=="simulate" && def.availability!=="disabled") ||
    (def.mode!=="read" && "read" in def) ||
    (def.mode!=="read" && "execute" in def) ||
    ["evaluate","propose","approve","commit","execute"].some(k=>k in def) ||
    (def.mode!=="simulate" && "simulate" in def) ||
    def.schemaContract.version!==1 || def.schemaContract.registrationId!==def.id ||
    !def.schemaContract.id.endsWith(".v1") ||
    def.schemaContract.inputSchemaFingerprint!==schemaFingerprint(def.inputSchema) ||
    def.schemaContract.outputSchemaFingerprint!==schemaFingerprint(def.outputSchema) ||
    !Number.isSafeInteger(def.budgets.maxOperations) || def.budgets.maxOperations!==1 ||
    def.budgets.timeoutMs<=0 || def.budgets.timeoutMs>10000 ||
    def.budgets.maxResultBytes<=0 || def.budgets.maxResultBytes>100000 ||
    def.budgets.maxInputBytes<=0 || def.budgets.maxInputBytes>10000 ||
    def.budgets.maxRangeDays<=0 || def.budgets.maxRangeDays>365 ||
    def.requiresApproval !== (def.mode==="propose" || def.mode==="approve" || def.mode==="commit"))
    throw new Error("Invalid P2 capability registration: "+def.id);
}

/** The manifest is private to this closure; consumers cannot mutate registrations. */
export function createP2Registry(registrations:readonly P2Registration[]) {
  const byId=new Map<string,P2Registration>();
  for(const def of registrations){
    validateRegistration(def);
    if(byId.has(def.id))throw new Error("Duplicate P2 capability identity: "+def.id);
    byId.set(def.id,def);
  }
  const manifest=Object.freeze([...byId.values()].map(def=>Object.freeze({
    id:def.id,version:def.version,mode:def.mode,owner:def.owner,
    purpose:def.purpose,currencyPolicy:def.currencyPolicy??"USD_only",sourceIds:[...def.sourceIds],
    canonicalReaderIds:[...def.canonicalReaderIds],
    allowedPurposes:[...def.allowedPurposes],
    schemaContract:def.schemaContract,
    inputJsonSchema:z.toJSONSchema(def.inputSchema,{unrepresentable:"any",reused:"inline"}),
    requiredRole:def.requiredRole,sensitivity:def.sensitivity,
    budgets:def.budgets,availability:def.availability,
    requiresApproval:def.requiresApproval,effectPolicy:def.effectPolicy,
  })));
  // The exact same scope/schema/purpose/period checks gate both a batch
  // preflight and the eventual dispatch. Never start one parallel sibling
  // while another is known to fail the registered input contract.
  const readPreflight=(scope:TrustedReadScope,id:string,rawInput:unknown)=>{
    if(!scope.shadowEnabled || scope.role!=="owner" || !scope.businessId ||
       scope.businessId!==scope.identity.businessId ||
       scope.businessId==="11111111-1111-1111-1111-111111111111")
      return {ok:false as const,response:unavailable("unauthorized")};
    const def=byId.get(id);
    if(!def)return {ok:false as const,response:unavailable("unknown_capability")};
    if(def.mode!=="read" || def.availability!=="shadow")
      return {ok:false as const,response:unavailable("mode_disabled")};
    let bytes:number;
    try{bytes=Buffer.byteLength(JSON.stringify(rawInput));}
    catch{return {ok:false as const,response:unavailable("invalid_request")};}
    if(bytes>def.budgets.maxInputBytes)
      return {ok:false as const,response:unavailable("input_limit")};
    const input=def.inputSchema.safeParse(rawInput);
    if(!input.success || discardedOutputKeys(rawInput,input.data) ||
       !def.allowedPurposes.includes((input.data as {purpose?:string}).purpose??""))
      return {ok:false as const,response:unavailable("invalid_request")};
    const period=(input.data as {period?:{from:string;to:string}}).period;
    if(period && Number.isFinite(Date.parse(period.from)) && Number.isFinite(Date.parse(period.to)) &&
       1+(Date.parse(period.to)-Date.parse(period.from))/86400000>def.budgets.maxRangeDays)
      return {ok:false as const,response:unavailable("unsupported_period")};
    return {ok:true as const,def,input:input.data};
  };
  return Object.freeze({
    /** Input-only preflight. No reader, simulation or effect is executed. */
    preflightRead(scope:TrustedReadScope,id:string,rawInput:unknown):boolean {
      return readPreflight(scope,id,rawInput).ok;
    },
    discover(scope:TrustedReadScope) {
      if(!scope.shadowEnabled || scope.role!=="owner" ||
         !scope.businessId || scope.businessId!==scope.identity.businessId ||
         scope.businessId==="11111111-1111-1111-1111-111111111111")return [];
      return manifest.filter(d=>d.mode==="read" && d.availability==="shadow").map(d=>structuredClone(d));
    },
    discoverSimulations(scope:TrustedReadScope) {
      if(!scope.shadowEnabled || scope.role!=="owner" || !scope.businessId ||
         scope.businessId!==scope.identity.businessId)return [];
      return manifest.filter(d=>d.mode==="simulate" && d.availability==="shadow")
        .map(d=>structuredClone(d));
    },
    /** Only trusted server orchestration may provide preauthorized source operands.
     * No model arguments can register, select or modify a source manifest.
     * This call has no database/HTTP effect handler: only reviewed pure simulations.
     */
    async invokeSimulation(scope:TrustedReadScope,id:string,rawInput:unknown,
      trustedSourceContext:unknown,onDispatch?:()=>void) {
      if(!scope.shadowEnabled || scope.role!=="owner" || !scope.businessId ||
         scope.businessId!==scope.identity.businessId ||
         scope.businessId==="11111111-1111-1111-1111-111111111111")
        return unavailable("unauthorized");
      const def=byId.get(id);
      if(!def)return unavailable("unknown_capability");
      if(def.mode!=="simulate" || def.availability!=="shadow" ||
         typeof def.simulate!=="function")return unavailable("mode_disabled");
      let bytes:number;
      try{bytes=Buffer.byteLength(JSON.stringify(rawInput));}
      catch{return unavailable("invalid_request");}
      if(bytes>def.budgets.maxInputBytes)return unavailable("input_limit");
      const input=def.inputSchema.safeParse(rawInput);
      if(!input.success || discardedOutputKeys(rawInput,input.data) ||
         !def.allowedPurposes.includes((input.data as {purpose?:string}).purpose??""))
        return unavailable("invalid_request");
      // Source bindings must correspond to THIS compiled six-mode registry.
      // The orchestrator cannot create a fifth reader simply by passing a
      // plausible binding object, and the model never controls this manifest.
      const sourceContext=trustedSourceContext as {
        bindings?:unknown;operands?:unknown;
      }|null;
      if(!sourceContext||!Array.isArray(sourceContext.bindings)||
         !Array.isArray(sourceContext.operands)||
         sourceContext.bindings.length>100||sourceContext.operands.length>12)
        return unavailable("invalid_source_context");
      const bindings=new Map<string,{
        canonicalReaderId:string;sourceIds:string[];purposes:string[];
        sensitivity:string;
      }>();
      for(const raw of sourceContext.bindings){
        if(!raw||typeof raw!=="object")return unavailable("invalid_source_context");
        const b=raw as {capabilityId?:unknown;canonicalReaderId?:unknown;
          sourceIds?:unknown;purposes?:unknown;sensitivity?:unknown};
        if(typeof b.capabilityId!=="string"||typeof b.canonicalReaderId!=="string"||
           !Array.isArray(b.sourceIds)||!Array.isArray(b.purposes)||
           typeof b.sensitivity!=="string"||bindings.has(b.capabilityId))
          return unavailable("invalid_source_context");
        const registered=byId.get(b.capabilityId);
        const matches=(actual:readonly string[],claimed:unknown[]) =>
          actual.length===claimed.length &&
          actual.every(id=>claimed.includes(id)) &&
          claimed.every(id=>typeof id==="string");
        if(!registered||registered.mode!=="read"||registered.availability!=="shadow"||
           !registered.canonicalReaderIds.includes(b.canonicalReaderId)||
           !matches(registered.sourceIds,b.sourceIds)||
           !matches(registered.allowedPurposes,b.purposes)||
           registered.sensitivity!==b.sensitivity)
          return unavailable("invalid_source_context");
        bindings.set(b.capabilityId,b as {
          canonicalReaderId:string;sourceIds:string[];purposes:string[];
          sensitivity:string;
        });
      }
      for(const raw of sourceContext.operands){
        if(!raw||typeof raw!=="object")return unavailable("invalid_source_context");
        const o=raw as {capabilityId?:unknown;canonicalReaderId?:unknown;
          sourceId?:unknown;sourcePurpose?:unknown};
        if(typeof o.capabilityId!=="string"||!bindings.has(o.capabilityId))
          return unavailable("invalid_source_context");
        const b=bindings.get(o.capabilityId)!;
        if(o.canonicalReaderId!==b.canonicalReaderId||
           typeof o.sourceId!=="string"||!b.sourceIds.includes(o.sourceId)||
           typeof o.sourcePurpose!=="string"||!b.purposes.includes(o.sourcePurpose))
          return unavailable("invalid_source_context");
      }
      // Simulations use the same authoritative dispatch boundary as reads.
      // Schema/byte/purpose/source-context rejection cannot consume operations.
      onDispatch?.();
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        const deadline=new Promise<{timeout:true}>(resolve=>{
          timer=setTimeout(()=>resolve({timeout:true}),def.budgets.timeoutMs);
        });
        const computed=Promise.resolve().then(()=>def.simulate!(scope,input.data,trustedSourceContext))
          .then(value=>({timeout:false as const,value}));
        const outcome=await Promise.race([deadline,computed]);
        if(outcome.timeout)return unavailable("simulation_timeout");
        const validated=def.outputSchema.safeParse(outcome.value);
        if(!validated.success||discardedOutputKeys(outcome.value,validated.data))
          return unavailable("invalid_result");
        const published=validated.data as Record<string,unknown>;
        if(published.mode!=="simulate"||published.proposal!==null ||
          published.executedEffects!==0||
          ["effect","approval","outbox","commit","action"].some(k=>Object.hasOwn(published,k)))
          return unavailable("invalid_result");
        if(Buffer.byteLength(JSON.stringify(validated.data))>def.budgets.maxResultBytes)
          return unavailable("output_limit");
        return validated.data;
      }catch{return unavailable("simulation_failure");}
      finally{if(timer)clearTimeout(timer);}
    },
    /** Optional trusted observer fires only once registry input/scope/period
     * preflight has succeeded, immediately before the actual reader dispatch.
     * Domain-result reason strings cannot prove whether a handler ran. */
    async invoke(scope:TrustedReadScope,id:string,rawInput:unknown,onDispatch?:()=>void) {
      const prepared=readPreflight(scope,id,rawInput);
      if(!prepared.ok)return prepared.response;
      const {def,input}=prepared;
      // A reader can itself return "invalid_request", "unsupported_period"
      // or "unauthorized" after actually running. Dispatch counting must be
      // based on this trusted boundary, not those result reason strings.
      onDispatch?.();
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        const timedOut=new Promise<{timedOut:true}>(resolve=>{
          timer=setTimeout(()=>resolve({timedOut:true}),def.budgets.timeoutMs);
        });
        const read=Promise.resolve().then(()=>def.read(scope,input.data))
          .then(value=>({timedOut:false as const,value}));
        const settled=await Promise.race([read,timedOut]);
        // Platform timeout is not a domain reader output, so never parse it
        // against a domain-specific result schema or reinterpret the reason.
        if(settled.timedOut)return unavailable("reader_timeout");
        const output=settled.value;
        // Unknown/forged effects, extra fields and malformed quality are not evidence.
        const validated=def.outputSchema.safeParse(output);
        if(!validated.success || discardedOutputKeys(output,validated.data))
          return unavailable("invalid_result");
        const actual=validated.data as {
          status?:string;value?:unknown;reason?:unknown;
          provenance?:{sourceRevision?:unknown;sourceId?:unknown;canonicalReaderId?:unknown;purpose?:unknown;asOf?:unknown};
          quality?:{missingInputs?:unknown;estimatedInputs?:unknown;staleInputs?:unknown};
        };
        if(["proposal","approve","approval","commit","effect","executedEffects",
          "applied","outbox"].some(k=>Object.hasOwn(actual,k)))return unavailable("invalid_result");
        if(!["verified","estimated","partial","unavailable","failed","conflict",
          "insufficient_evidence"].includes(actual.status??""))
          return unavailable("invalid_result");
        if(["unavailable","failed","conflict","insufficient_evidence"].includes(actual.status??"")){
          if(actual.value!==null ||
            typeof actual.reason!=="string" || actual.reason.length>100 ||
            Object.keys(actual).some(k=>!["status","value","reason"].includes(k)))
            return unavailable("invalid_result");
        }else if(actual.value===null || actual.value===undefined)
          return unavailable("invalid_result");
        // Even partial or estimated canonical evidence needs source provenance
        // and quality; model metadata alone is not a trusted reader result.
        if(["verified","estimated","partial"].includes(actual.status??"")){
          const p=actual.provenance,q=actual.quality;
          const registeredSource=typeof p?.sourceId==="string" &&
            def.sourceIds.includes(p.sourceId);
          const canonicalReader=typeof p?.canonicalReaderId==="string" &&
            def.canonicalReaderIds.includes(p.canonicalReaderId);
          // An explicitly supplied identity must match even when the other
          // source field is valid, rather than allowing a forged second ID.
          const sourceValid=p?.sourceId===undefined || registeredSource;
          const readerValid=p?.canonicalReaderId===undefined || canonicalReader;
          const revision=p?.sourceRevision;
          const validRevision=revision===null ||
            (typeof revision==="string" && revision.length>0);
          const arrays=[q?.missingInputs,q?.estimatedInputs,q?.staleInputs];
          if(!p || typeof p.asOf!=="string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(p.asOf) ||
            !canonicalReader || !sourceValid || !readerValid ||
            typeof p.purpose!=="string" ||
            p.purpose!==(input.data as {purpose?:string}).purpose ||
            !validRevision ||
            !q || arrays.some(items=>!Array.isArray(items) ||
              items.some((item:unknown)=>typeof item!=="string")))
            return unavailable("invalid_result");
        }
        if(actual.status==="verified" &&
          (typeof actual.provenance?.sourceRevision!=="string" ||
            !actual.provenance.sourceRevision))
          return unavailable("invalid_result");
        if(actual.status==="verified" &&
          [actual.quality?.missingInputs,actual.quality?.estimatedInputs,
            actual.quality?.staleInputs].some(x=>Array.isArray(x) && x.length>0))
          return unavailable("invalid_result");
        if(actual.status==="estimated" &&
          (!Array.isArray(actual.quality?.estimatedInputs) ||
            actual.quality.estimatedInputs.length===0))
          return unavailable("invalid_result");
        if(Buffer.byteLength(JSON.stringify(validated.data))>def.budgets.maxResultBytes)
          return unavailable("output_limit");
        return validated.data;
      }catch{return unavailable("reader_failure");}
      finally {if(timer)clearTimeout(timer);}
    },
  });
}
