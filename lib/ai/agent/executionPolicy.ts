/** Admission limits protect transport and server slices, not business intent.
 * Let a completed answer finish immediately; allow further evidence when needed.
 * The trusted legacy paid runner retains its original caps exactly. */
import {PRODUCTION_SUPERVISOR_OPENAI_MODEL} from "@/lib/ai/conversations/modelConfig";
export type ExecutionBudget={maxElapsedMs:number;maxModelCalls:number;maxToolCalls:number;maxInputTokens:number;maxOutputTokens:number};
export type ExecutionPolicy={elapsedMs:number;maxWorkCalls:number;maxToolCalls:number;maxTurnOutput:number;
 maxWorkOutput:number;finalReserve:number;finalTimeReserve:number};
export function executionPolicy(model:string,worker:ExecutionBudget|undefined,legacyPaid:boolean):ExecutionPolicy{
 const luna=model===PRODUCTION_SUPERVISOR_OPENAI_MODEL;
 const adaptive=luna&&!legacyPaid;
 // Retain the existing 60s bounded execution slice; durable continuation uses
 // the same run identity. Do not extend an active HTTP lease past its deadline.
 const elapsedMs=Math.min(60000,worker?.maxElapsedMs??60000);
 const maxTurnOutput=Math.min(luna?(adaptive?32768:25000):Number.MAX_SAFE_INTEGER,worker?.maxOutputTokens??Infinity);
 const finalReserve=adaptive?Math.min(8192,Math.max(1,Math.floor(maxTurnOutput/3))):1200;
 return {elapsedMs,maxWorkCalls:Math.max(0,Math.min(adaptive?12:5,(worker?.maxModelCalls??Infinity)-1)),
  maxToolCalls:Math.min(adaptive?24:8,worker?.maxToolCalls??Infinity),
  maxTurnOutput,maxWorkOutput:luna&&!worker?16384:adaptive?8192:1200,finalReserve,
  finalTimeReserve:Math.min(12000,Math.floor(elapsedMs/5))};
}
export function remainingOutput(policy:ExecutionPolicy,spent:number,final:boolean):number{
 return Math.max(0,policy.maxTurnOutput-spent-(final?0:Math.min(policy.finalReserve,policy.maxTurnOutput)));
}
export function requestOutputCap(policy:ExecutionPolicy,spent:number,final:boolean,transportCap=Infinity):number{
 return Math.max(0,Math.min(final?policy.finalReserve:policy.maxWorkOutput,transportCap,remainingOutput(policy,spent,final)));
}
