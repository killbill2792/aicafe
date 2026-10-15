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
};
type Limits = Readonly<{
  maxOperations: number; timeoutMs: number; maxResultBytes: number;
  maxInputBytes: number; maxRangeDays: number;
}>;
type Base<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  readonly id: string; readonly version: 1; readonly owner: string;
  readonly purpose: string; readonly sourceIds: readonly string[];
  readonly allowedPurposes: readonly string[];
  readonly inputSchema: I; readonly outputSchema: O;
  readonly schemaContract: Readonly<{
    id: string; version: 1; inputSchemaFingerprint: string; outputSchemaFingerprint: string;
  }>;
  readonly requiredRole: "owner"; readonly sensitivity: "normal" | "staff" | "financial";
  readonly budgets: Limits;
  readonly requiresApproval: boolean;
  readonly effectPolicy: "deny";
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
type Inert<M extends Exclude<CapabilityMode,"read">> = Base & {
  readonly mode:M; readonly availability:"disabled";
  readonly read?:never; readonly simulate?:never; readonly evaluate?:never;
  readonly propose?:never; readonly approve?:never; readonly commit?:never;
};
export type SimulateRegistration=Inert<"simulate">;
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

function validateRegistration(def:P2Registration) {
  if(!/^[a-z][a-z0-9._-]{2,120}$/.test(def.id) || def.version!==1 ||
    !CAPABILITY_MODES.includes(def.mode) || !def.owner || !def.purpose ||
    !Array.isArray(def.sourceIds) || !def.sourceIds.length ||
    !Array.isArray(def.allowedPurposes) || !def.allowedPurposes.length ||
    def.requiredRole!=="owner" || def.effectPolicy!=="deny" ||
    (def.mode==="read" && (def.availability!=="shadow" || typeof def.read!=="function")) ||
    (def.mode!=="read" && def.availability!=="disabled") ||
    (def.mode!=="read" && "read" in def) ||
    (def.mode!=="read" && "execute" in def) ||
    ["simulate","evaluate","propose","approve","commit","execute"].some(k=>k in def) ||
    def.schemaContract.version!==1 ||
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
    purpose:def.purpose,sourceIds:[...def.sourceIds],
    allowedPurposes:[...def.allowedPurposes],
    schemaContract:def.schemaContract,
    inputJsonSchema:z.toJSONSchema(def.inputSchema,{unrepresentable:"any",reused:"inline"}),
    requiredRole:def.requiredRole,sensitivity:def.sensitivity,
    budgets:def.budgets,availability:def.availability,
    requiresApproval:def.requiresApproval,effectPolicy:def.effectPolicy,
  })));
  return Object.freeze({
    discover(scope:TrustedReadScope) {
      if(!scope.shadowEnabled || scope.role!=="owner" ||
         !scope.businessId || scope.businessId!==scope.identity.businessId ||
         scope.businessId==="11111111-1111-1111-1111-111111111111")return [];
      return manifest.filter(d=>d.mode==="read" && d.availability==="shadow");
    },
    async invoke(scope:TrustedReadScope,id:string,rawInput:unknown) {
      if(!scope.shadowEnabled || scope.role!=="owner" || !scope.businessId ||
         scope.businessId!==scope.identity.businessId ||
         scope.businessId==="11111111-1111-1111-1111-111111111111")
        return unavailable("unauthorized");
      const def=byId.get(id);
      if(!def)return unavailable("unknown_capability");
      if(def.mode!=="read" || def.availability!=="shadow")return unavailable("mode_disabled");
      let bytes:number;
      try {bytes=Buffer.byteLength(JSON.stringify(rawInput));}
      catch{return unavailable("invalid_request");}
      if(bytes>def.budgets.maxInputBytes)return unavailable("input_limit");
      const input=def.inputSchema.safeParse(rawInput);
      if(!input.success || !def.allowedPurposes.includes((input.data as {purpose?:string}).purpose??""))
        return unavailable("invalid_request");
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        const timedOut=new Promise<ReturnType<typeof unavailable>>(resolve=>{
          timer=setTimeout(()=>resolve(unavailable("reader_timeout")),def.budgets.timeoutMs);
        });
        const read=Promise.resolve().then(()=>def.read(scope,input.data));
        const output=await Promise.race([read,timedOut]);
        // Unknown/forged effects, extra fields and malformed quality are not evidence.
        const validated=def.outputSchema.safeParse(output);
        if(!validated.success)return unavailable("invalid_result");
        if(Buffer.byteLength(JSON.stringify(validated.data))>def.budgets.maxResultBytes)
          return unavailable("output_limit");
        return validated.data;
      }catch{return unavailable("reader_failure");}
      finally {if(timer)clearTimeout(timer);}
    },
  });
}
