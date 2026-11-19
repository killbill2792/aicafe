import { z } from "zod";

export const runScopeSchema = z.strictObject({
  businessId: z.uuid(), ownerUserId: z.uuid(), threadId: z.uuid(),
});
export type RunScope = z.infer<typeof runScopeSchema>;

export const stepSpecSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_:-]{0,79}$/u),
  // A timed-out external effect is never blindly replayed.
  // "idempotent" is only for executors that honor the supplied stable key.
  retry: z.enum(["idempotent", "reconcile"]),
});
export type StepSpec = z.infer<typeof stepSpecSchema>;

const runRowSchema = z.object({
  id: z.uuid(), business_id: z.uuid(), owner_user_id: z.uuid(),
  thread_id: z.uuid(), request_key: z.uuid(), plan_hash: z.string().length(64),
  status: z.enum(["pending", "running", "blocked", "completed"]),
  final_report_ref: z.string().nullable(),
});
export type DurableRun = {
  id: string; businessId: string; ownerUserId: string; threadId: string;
  requestKey: string; status: "pending" | "running" | "blocked" | "completed";
  finalReportRef: string | null;
};
export function decodeRun(row: unknown): DurableRun {
  const r = runRowSchema.parse(row);
  return {
    id: r.id, businessId: r.business_id, ownerUserId: r.owner_user_id,
    threadId: r.thread_id, requestKey: r.request_key,
    status: r.status, finalReportRef: r.final_report_ref,
  };
}

const claimedSchema = z.object({
  kind: z.literal("claimed"),
  idempotency_key: z.string().min(1),
  step: z.object({
    step_key: z.string(), retry_mode: z.enum(["idempotent", "reconcile"]),
    claim_token: z.uuid(), lease_until: z.string(), attempts: z.number().int().positive(),
  }),
});
const claimSchema = z.discriminatedUnion("kind", [
  claimedSchema,
  z.object({ kind: z.literal("busy") }),
  z.object({ kind: z.literal("blocked") }),
  z.object({ kind: z.literal("completed") }),
  z.object({ kind: z.literal("ready_for_report") }),
]);
export type StepClaim =
  | { kind: "claimed"; key: string; retry: StepSpec["retry"];
      claimToken: string; leaseUntil: string; attempt: number; idempotencyKey: string }
  | { kind: "busy" | "blocked" | "completed" | "ready_for_report" };
export function decodeClaim(value: unknown): StepClaim {
  const r = claimSchema.parse(value);
  if (r.kind !== "claimed") return { kind: r.kind };
  return {
    kind: "claimed", key: r.step.step_key, retry: r.step.retry_mode,
    claimToken: r.step.claim_token, leaseUntil: r.step.lease_until,
    attempt: r.step.attempts, idempotencyKey: r.idempotency_key,
  };
}

export interface DurableRunRepository {
  start(scope: RunScope, requestKey: string, steps: readonly StepSpec[]): Promise<DurableRun>;
  claim(scope: RunScope, runId: string, workerId: string, leaseSeconds: number): Promise<StepClaim>;
  renew(scope: RunScope, runId: string, key: string, token: string, leaseSeconds: number): Promise<boolean>;
  complete(scope: RunScope, runId: string, key: string, token: string, resultRef: string): Promise<void>;
  // Caller must first verify the receipt against the canonical effect ledger.
  reconcile(scope: RunScope, runId: string, key: string, verifiedResultRef: string): Promise<void>;
  finish(scope: RunScope, runId: string, finalReportRef: string): Promise<DurableRun>;
}

export const ownerRunInputSchema = z.strictObject({
  locale: z.enum(["en","es","ar"]),
  attachmentIds: z.array(z.uuid()).max(3).refine(ids=>new Set(ids).size===ids.length),
});
export type OwnerRunInput=z.infer<typeof ownerRunInputSchema>;

const checkpointPhaseSchema=z.enum(["ready","provider_pending","read_pending","effect_pending"]);
export const checkpointRowSchema=z.object({
  checkpoint_seq:z.number().int().nonnegative(),
  checkpoint_phase:checkpointPhaseSchema,
  checkpoint_operation:z.uuid().nullable(),
  checkpoint_tool:z.string().nullable(),
  checkpoint_receipts:z.array(z.object({
    operation:z.uuid(),phase:z.enum(["provider_pending","read_pending","effect_pending"]),
    tool:z.string().nullable(),receipt:z.string().max(400),
  })).max(256),
});
export type CheckpointRow=z.infer<typeof checkpointRowSchema>;

/** Passed into the existing one-agent loop, never model-controlled. A failure
 * at a checkpoint boundary must escape tool/provider error recovery. */
/** Only reviewed canonical read selectors; never arbitrary model arguments,
 * owner-supplied financial facts, private connector queries or source contents. */
export function recoverableReadSelector(name:string,raw:unknown,resultPeriod?:unknown):Record<string,unknown>|null {
  const empty=z.strictObject({});
  const range=z.strictObject({from:z.iso.date(),to:z.iso.date()}).refine(x=>x.from<=x.to);
  const week=z.strictObject({week_start:z.iso.date().nullable()});
  const item=z.strictObject({itemId:z.uuid()});
  if(["get_staff","get_inventory","get_labor_rules","get_bills","get_supervisor_permissions"].includes(name))
    return empty.safeParse(raw).success?{}:null;
  if(["get_peak_hours","get_employee_sales","get_payroll_facts"].includes(name)){
    const parsed=range.safeParse(raw);return parsed.success?parsed.data:null;
  }
  if(["get_week_schedule","get_coverage_gaps"].includes(name)){
    const parsed=week.safeParse(raw);return parsed.success&&parsed.data.week_start!==null?parsed.data:null;
  }
  if(name==="get_product_costs"){
    const parsed=item.safeParse(raw);return parsed.success?parsed.data:null;
  }
  if(["get_profit","get_sales","get_labor","get_cost_summary"].includes(name)){
    const parsed=z.strictObject({period:z.unknown(),ownerInputs:z.null().optional()}).safeParse(raw);
    if(!parsed.success)return null;
    const period=range.safeParse(resultPeriod??parsed.data.period);
    return period.success?{period:period.data}:null;
  }
  return null;
}
export type OwnerReadReference={name:string;selector:Record<string,unknown>};
export type OwnerRunCheckpoint = {
  assertLive:()=>Promise<void>;
  beginProvider:()=>Promise<void>;
  endProvider:(completed:boolean)=>Promise<void>;
  beginTool:(name:string,raw:unknown,repeatSafe:boolean)=>Promise<import("@/lib/ai/agent/tools").AgentToolResult|null>;
  endTool:(result:import("@/lib/ai/agent/tools").AgentToolResult,noEffect?:boolean)=>Promise<void>;
  resumeContext:()=>Promise<string|null>;
  readReferences?:()=>readonly OwnerReadReference[];
  restoredResults?:()=>Promise<import("@/lib/ai/agent/tools").AgentToolResult[]>;
  canYield:()=>boolean;
  yieldForRetry:(seconds:number,kind?:"retry"|"technical"|"contended")=>Promise<boolean>;
};

/** The database binds the original question to the explicit owner response. */
export const matchedOwnerAnswerSchema=z.object({questionId:z.uuid(),answerId:z.uuid(),question:z.string().trim().min(1).max(8000),answer:z.string().trim().min(1).max(4000)});
export type MatchedOwnerAnswer=z.infer<typeof matchedOwnerAnswerSchema>;

/** Only the original authenticated owner statement and exact persisted,
 * same-run owner answers. Never include assistant questions, later unrelated
 * transcript messages, attachment text or model-generated claims. */
export function ownerRunStatement(original:string,answers:readonly MatchedOwnerAnswer[]=[]):string{
  return answers.length?[original,...answers.map(pair=>pair.answer)].join("\n"):original;
}
