import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import {randomUUID} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {PRODUCTION_SUPERVISOR_OPENAI_MODEL,configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {providerUsageReceipt} from "@/lib/ai/agent/executionPolicy";
import {modelTokenUsage,standardModelTokenRates,estimateModelCallCostMicros,hostedWebActualCostMicros} from "@/lib/calc/supervisorTokenCost";

/** Caps come from authenticated server configuration, never a model reply.
 * A cap of zero denies new work; usage is measured across the whole run. */
export type WorkerBudget = Readonly<{
  maxElapsedMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}>;

export type WorkerUsage = Readonly<{
  elapsedMs: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}>;

export type UsageStopReason = "timeout" | "budget" | null;

export function usageStopReason(usage: WorkerUsage, cap: WorkerBudget): UsageStopReason {
  for (const n of Object.values({ ...usage, ...cap })) {
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error("invalid_supervisor_worker_usage");
  }
  if (usage.elapsedMs >= cap.maxElapsedMs) return "timeout";
  if (usage.modelCalls >= cap.maxModelCalls ||
    usage.toolCalls >= cap.maxToolCalls ||
    usage.inputTokens >= cap.maxInputTokens ||
    usage.outputTokens >= cap.maxOutputTokens) return "budget";
  return null;
}

/** One async-local meter spans every sequential continuation in a durable
 * run. Ordinary browser/WhatsApp conversations never see this meter. */
type WorkerMeter = { cap: WorkerBudget; started: number; used: WorkerUsage; providerOutputCap:number };
const workerBudgets = new AsyncLocalStorage<WorkerMeter>();
const FINISH_RESERVE_MS = 3000; // keep time for canonical finish/lease acknowledgement
const empty: WorkerUsage = { elapsedMs: 0, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };

export function currentWorkerBudget(): WorkerBudget | undefined {
  const meter = workerBudgets.getStore();
  if (!meter) return undefined;
  return {
    maxElapsedMs: Math.max(0, meter.cap.maxElapsedMs -
      Math.max(0, Date.now() - meter.started) - FINISH_RESERVE_MS),
    maxModelCalls: Math.max(0, meter.cap.maxModelCalls - meter.used.modelCalls),
    maxToolCalls: Math.max(0, meter.cap.maxToolCalls - meter.used.toolCalls),
    maxInputTokens: Math.max(0, meter.cap.maxInputTokens - meter.used.inputTokens),
    maxOutputTokens: Math.max(0, meter.cap.maxOutputTokens - meter.used.outputTokens),
  };
}

/** Count each finished one-agent turn before another one may start. Usage is
 * captured even when a provider returns an incomplete/budget-limited answer. */
export function recordWorkerTurnUsage(used: WorkerUsage): void {
  const meter = workerBudgets.getStore();
  if (!meter) return;
  usageStopReason(used, meter.cap); // validate nonnegative safe integers
  for (const key of ["modelCalls", "toolCalls", "inputTokens", "outputTokens"] as const) {
    const next = meter.used[key] + used[key];
    if (!Number.isSafeInteger(next)) throw new Error("invalid_supervisor_worker_usage");
    meter.used = { ...meter.used, [key]: next };
  }
}

export function currentWorkerUsage(): WorkerUsage | undefined {
  const meter = workerBudgets.getStore();
  return meter ? { ...meter.used, elapsedMs: Math.max(0, Date.now() - meter.started) } : undefined;
}
export function workerBudgetExhausted(): UsageStopReason {
  const remaining = currentWorkerBudget();
  return remaining ? usageStopReason(empty, remaining) : null;
}
export async function withWorkerBudget<T>(budget: WorkerBudget, work: () => Promise<T>,providerOutputCap=1200): Promise<T> {
  if (usageStopReason(empty, budget)) throw new Error("supervisor_worker_budget_exhausted");
  if(![1200,8192].includes(providerOutputCap))throw Error("invalid_worker_provider_cap");
  return workerBudgets.run({ cap: budget, started: Date.now(), used: empty,providerOutputCap }, work);
}

/** The existing durable owner-turn lease, not a new queue or agent. Each
 * provider launch spends in the existing persisted system-attempt ledger.
 * Request bodies and owner content are never written to that ledger. */
type DurableProviderScope = {
  db: SupabaseClient; businessId:string; ownerUserId:string; threadId:string;
  runId:string; ownerMessageId:string; jobId:string; claimToken:string;
  budget:WorkerBudget; ownerDailyCap:number|null; authorize:()=>Promise<void>;
};
type DurableProviderContext = { scope:DurableProviderScope; launched:string[]; denied:boolean };
const durableProviderTurns = new AsyncLocalStorage<DurableProviderContext>();
/** Expanded capacity requires a migrated database. On rolling deploy, an
 * absent RPC keeps the legacy cap; other failures stop admission. */
export async function loadModelExecutionCap(db:SupabaseClient,model=configuredSupervisorModel()):Promise<number>{
  if(model!==PRODUCTION_SUPERVISOR_OPENAI_MODEL||
     process.env.AI_CAFE_LIVE_ACCEPTANCE==="OWNER_APPROVED_LOCAL_ONLY"||
     process.env.AICAFE_TASK14B_BUDGET_LEDGER)return 1200;
  const {data,error}=await db.rpc("supervisor_model_execution_cap",{p_model:model});
  if(error){
    if(error.code==="PGRST202"||error.code==="42883")return 1200;
    throw Error("worker_execution_cap_unavailable");
  }
  if(data!==8192&&data!==1200)throw Error("worker_execution_cap_unavailable");
  return data;
}
/** Keep the independently authorized unattended spend envelope distinct from
 * the interactive Supervisor's reasoning allowance, before request creation. */
export function currentDurableProviderOutputCap():number|undefined{
  return workerBudgets.getStore()?.providerOutputCap??(durableProviderTurns.getStore()?1200:undefined);
}
export function withDurableProviderTurn<T>(scope:DurableProviderScope,work:()=>Promise<T>):Promise<T>{
  return durableProviderTurns.run({scope,launched:[],denied:false},work);
}
export function currentDurableUsageAccounting(
  owner:{businessId:string;ownerUserId:string;threadId:string;ownerMessageId:string},calls:number,
):{runId:string;attemptIds:string[]}|null{
  const ctx=durableProviderTurns.getStore();
  if(!ctx||calls===0)return null;
  if(ctx.scope.businessId!==owner.businessId||ctx.scope.ownerUserId!==owner.ownerUserId||
     ctx.scope.threadId!==owner.threadId||ctx.scope.ownerMessageId!==owner.ownerMessageId||
     calls!==ctx.launched.length)throw new Error("durable_usage_scope_mismatch");
  return {runId:ctx.scope.runId,attemptIds:[...ctx.launched]};
}
function configuredReserve(value:string|undefined,fallback:number):number{
  if(value===undefined)return fallback;
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)
    throw new Error("invalid_worker_provider_reservation_setting");
  return Number(value);
}
export type DurableProviderReservation={
  launched:()=>void;
  complete:(response:{model?:unknown;service_tier?:unknown;usage?:unknown;output?:unknown})=>Promise<void>;
};

/** A conservative reservation is not an exact provider invoice. Count every
 * serialized UTF-8 byte plus framing allowance; multimedia/hosted retrieval
 * reserves the whole known standard short-context limit. Commercial costs are measured, not a Max admission gate. */
export async function reserveDurableProviderRequest(
  params:Record<string,unknown>,kind:"responses"|"hosted_web"="responses",
):Promise<DurableProviderReservation|null>{
  const ctx=durableProviderTurns.getStore();if(!ctx)return null;
  const {scope}=ctx;
  if(ctx.denied)throw new Error("durable_provider_reservation_unavailable");
  try{
    const model=params.model,output=params.max_output_tokens;
    if(typeof model!=="string"||typeof output!=="number"||!Number.isSafeInteger(output)||
       output<1||output>(currentDurableProviderOutputCap()??1200))throw new Error("durable_provider_request_invalid");
    // Measure text/framing separately from trusted attachment binary
    // transport. The provider tokenizes the decoded media, not the base64
    // representation. Strip only the binary data URL in a real user content
    // item from this accounting COPY, never from the transmitted request.
    // All text/tool outputs, filenames and ordinary URL bytes still count.
    // Unknown media types are not discounted. Known inline media reserves the
    // full existing short-context ceiling; measured usage remains fenced.
    let multimedia=false;
    const accountingInput=Array.isArray(params.input)?params.input.map(item=>{
      if(!item||typeof item!=="object"||item.role!=="user"||!Array.isArray(item.content))return item;
      return {...item,content:item.content.map((part:unknown)=>{
        if(!part||typeof part!=="object")return part;
        const p=part as Record<string,unknown>;
        const field=p.type==="input_image"?"image_url":p.type==="input_file"?"file_data":null;
        if(!field||typeof p[field]!=="string")return part;
        multimedia=true;
        const raw=p[field];
        const prefix=p.type==="input_image"?
          /^data:image\/(?:jpeg|png|webp);base64,/u.exec(raw)?.[0]:
          /^data:application\/pdf;base64,/u.exec(raw)?.[0];
        if(!prefix||raw.length<=prefix.length||!/^[+\/A-Za-z0-9]+={0,2}$/u.test(raw.slice(prefix.length)))return part;
        return {...p,[field]:prefix};
      })};
    }):params.input;
    const serialized=JSON.stringify({...params,input:accountingInput});
    const inputUpper=Math.max(Buffer.byteLength(serialized,"utf8")+4096,
      multimedia||kind==="hosted_web"?272000:1);
    const rates=standardModelTokenRates(model,params.service_tier,inputUpper);
    const primary=model===configuredSupervisorModel();
    const configuredInput=primary?process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS:undefined;
    const configuredOutput=primary?process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS:undefined;
    const inRate=Math.max(Number(rates?.input),Number(configuredInput??0));
    const outRate=Math.max(Number(rates?.output),Number(configuredOutput??0));
    const hostedRate=process.env.SUPERVISOR_WORKER_HOSTED_WEB_RESERVE_MICROS;
    const hostedFee=kind==="hosted_web"?(hostedRate===undefined?null:configuredReserve(hostedRate,0)):0;
    if(inputUpper>272000) throw new Error("durable_provider_request_invalid");
    const estimate=hostedFee===null?null:Math.ceil(inputUpper*inRate+output*outRate)+hostedFee;
    // An unknown rate remains NULL telemetry, never a commercial refusal for Max.
    const costUpper=estimate!==null&&Number.isSafeInteger(estimate)&&estimate>=0?estimate:null;
    await scope.authorize();
    const id=randomUUID();
    const {error}=await scope.db.rpc("supervisor_reserve_durable_model_call",{
      p_attempt_id:id,p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
      p_thread_id:scope.threadId,p_run_id:scope.runId,p_owner_message_id:scope.ownerMessageId,
      p_job_id:scope.jobId,p_claim_token:scope.claimToken,p_model:model,p_input_upper:inputUpper,
      p_output_cap:output,p_cost_upper:costUpper,p_max_calls:scope.budget.maxModelCalls,
      p_max_input_upper:configuredReserve(process.env.SUPERVISOR_WORKER_MAX_RESERVED_INPUT_UNITS,600000),
      p_max_output_cap:scope.budget.maxOutputTokens,
      p_max_cost:null,
      p_owner_daily_cap:scope.ownerDailyCap,
    });
    if(error)throw new Error("durable_provider_reservation_denied",{cause:error});
    let started=false,completed=false,startedAt=0;
    return {
      launched:()=>{if(started||ctx.denied)throw new Error("durable_provider_launch_conflict");
        started=true;startedAt=Date.now();ctx.launched.push(id);},
      complete:async(response)=>{
        if(!started||completed)throw new Error("durable_provider_completion_conflict");
        const actual=response.model;
        const measured=modelTokenUsage(response.usage);
        const actualRates=measured&&typeof actual==="string"?
          standardModelTokenRates(actual,response.service_tier,measured.inputTokens):null;
        if(!measured||typeof actual!=="string"||actual!==model||
          measured.inputTokens>inputUpper||measured.outputTokens>output){
          ctx.denied=true;throw new Error("durable_provider_usage_unverified");
        }
        const tokenCost=actualRates?estimateModelCallCostMicros(measured,actualRates):null;
        const cost=kind==='hosted_web'?hostedWebActualCostMicros(tokenCost,response.output):tokenCost;
        const completeArgs={
          p_attempt_id:id,p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
          p_thread_id:scope.threadId,p_model:actual,p_input_tokens:measured.inputTokens,
          p_output_tokens:measured.outputTokens,p_estimated_cost_micros:cost,
        };
        const metrics=providerUsageReceipt({requestedModel:model,kind,outcome:"completed",final:params.tool_choice==="none",nativeSearch:Array.isArray(params.tools)&&params.tools.some(t=>t?.type==="tool_search"),outputCap:output,durationMs:Math.max(0,Date.now()-startedAt),response});
        let {error}=await scope.db.rpc("supervisor_complete_investigation_model_call",{...completeArgs,p_execution_metrics:metrics});
        if(error?.code==="PGRST202"||error?.code==="42883")({error}=await scope.db.rpc("supervisor_complete_investigation_model_call",completeArgs));
        if(error){ctx.denied=true;throw new Error("durable_provider_completion_unavailable",{cause:error});}
        completed=true;
      },
    };
  }catch(error){ctx.denied=true;throw error;}
}
