/** Owner-approved, fail-closed local Task14B LIVE provider budget.
 * The ordinary production path never activates this gate. No new database or
 * external effect system. Costs here are conservative standard-rate reserves,
 * NOT an invoice. Unknown model/tier/cost fails before any paid request. */
import {mkdirSync,rmdirSync,readFileSync,writeFileSync,renameSync,unlinkSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {setTimeout as sleep} from "node:timers/promises";
import {isAbsolute} from "node:path";

export const TASK14B_MAX_RESERVED_MICROS=180_000; // $0.18, below $0.80 owner maximum
export const TASK14B_MAX_PAID_CALLS=18;
export const TASK14B_MAX_REQUEST_BYTES=120_000;
export const TASK14B_MAX_RESPONSE_TOKENS=1_200;
export type PaidBudgetRecord={head:string;attempts:number;reservedMicros:number};
export function paidRequestReservation(params:Record<string,unknown>,json:string){
 if(params.model!=="gpt-6-luna")throw Error("task14b_budget:unexpected_live_model");
 if(params.service_tier!==undefined&&!["standard","auto","default"].includes(String(params.service_tier)))
  throw Error("task14b_budget:unpriced_tier");
 if(params.background===true)throw Error("task14b_budget:untracked_background_call");
 const tools=params.tools;
 if(Array.isArray(tools)&&tools.some(t=>!t||typeof t!=="object"||
    (t as {type?:unknown}).type!=="function"))
  throw Error("task14b_budget:unpriced_provider_tool");
 const output=params.max_output_tokens;
 if(!Number.isSafeInteger(output)||Number(output)<=0||Number(output)>TASK14B_MAX_RESPONSE_TOKENS)
  throw Error("task14b_budget:response_limit");
 const bytes=Buffer.byteLength(json,"utf8");
 if(bytes<=0||bytes>TASK14B_MAX_REQUEST_BYTES)
  throw Error("task14b_budget:input_limit");
 // Conservative token upper bound: one token per serialized UTF-8 byte;
 // standard Luna input $0.10/M and output $0.50/M, no cache discount.
 // Microunits: bytes * 0.10 + output tokens * 0.50.
 return {bytes,reservedMicros:Math.ceil(bytes*0.10+Number(output)*0.50)};
}
const valid=(v:unknown):v is PaidBudgetRecord=>{
 const x=v as PaidBudgetRecord|null;
 return !!x&&typeof x==="object"&&/^[a-f0-9]{40}$/.test(x.head)&&
  Number.isSafeInteger(x.attempts)&&x.attempts>=0&&
  Number.isSafeInteger(x.reservedMicros)&&x.reservedMicros>=0;
};
/** Reserve BEFORE the network call, including retries and transport errors.
 * Lock directory + atomic rename protects the counter across Next processes. */
export async function reserveTask14bPaidRequest(params:Record<string,unknown>,json:string){
 const file=process.env.AICAFE_TASK14B_BUDGET_LEDGER;
 if(!file)return; // zero change to ordinary production Supervisor
 if(process.env.AI_CAFE_LIVE_ACCEPTANCE!=="OWNER_APPROVED_LOCAL_ONLY"||
    process.env.APP_URL!=="http://127.0.0.1:3000"||
    process.env.NEXT_PUBLIC_SUPABASE_URL!=="http://127.0.0.1:54321"||
    !isAbsolute(file)||!file.startsWith("/"))
  throw Error("task14b_budget:disposable_environment_required");
 const {reservedMicros}=paidRequestReservation(params,json);
 const lock=file+".lock";
 let held=false;
 for(let i=0;i<50;i++){
  try{mkdirSync(lock,{mode:0o700});held=true;break}
  catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;await sleep(50)}
 }
 if(!held)throw Error("task14b_budget:lock_unavailable");
 let temp:string|null=null;
 try{
  let raw:unknown;try{raw=JSON.parse(readFileSync(file,"utf8"))}catch{
   throw Error("task14b_budget:ledger_unavailable");
  }
  if(!valid(raw)||raw.head!==process.env.HEAD_SHA)
   throw Error("task14b_budget:wrong_head_or_ledger");
  if(raw.attempts>=TASK14B_MAX_PAID_CALLS||
      raw.reservedMicros+reservedMicros>TASK14B_MAX_RESERVED_MICROS)
   throw Error("task14b_budget:paid_ceiling_reached");
  const next={head:raw.head,attempts:raw.attempts+1,
    reservedMicros:raw.reservedMicros+reservedMicros};
  temp=file+"."+randomUUID()+".tmp";
  writeFileSync(temp,JSON.stringify(next)+"\n",{mode:0o600,flag:"wx"});
  renameSync(temp,file);temp=null;
 }finally{
  if(temp){try{unlinkSync(temp)}catch{}}
  rmdirSync(lock);
 }
}
