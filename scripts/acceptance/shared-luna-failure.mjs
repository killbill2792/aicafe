// Trusted host only. This failure diagnostic is never an acceptance receipt.
import {constants,openSync,fstatSync,readFileSync,closeSync,writeFileSync,realpathSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {MAX_CALLS,MAX_RESERVATION_MICROS,safePolicyDenial,safeProviderRejection} from "./task14b-broker.mjs";

const isObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const bounded=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const short=x=>typeof x==="string"&&x.length<=128?x:"";
const shaRe=/^[a-f0-9]{40}$/;
const terminals=new Set(["attempted","completed","transport_unknown","provider_rejected",
  "provider_failed","unpriced_or_wrong_provider","incomplete"]);
const failed=(head,auditStatus)=>({schemaVersion:1,result:"FAILED",acceptanceProof:false,
  head:shaRe.test(head??"")?head:null,auditStatus});

// Revalidate the broker's safe categories rather than copying any property
// wholesale. No prompts, arguments, provider IDs, tool names or raw messages.
export function projectFailureAudit(audit,head){
  const invalid=()=>failed(head,"invalid");
  if(typeof head!=="string"||!shaRe.test(head)||!isObject(audit)||audit.head!==head||
    !bounded(audit.attempts,0,MAX_CALLS)||!bounded(audit.reservedMicros,0,MAX_RESERVATION_MICROS)||
    !bounded(audit.deniedCount,0,1_000_000)||!Array.isArray(audit.policyDenials)||
    audit.policyDenials.length!==Math.min(audit.deniedCount,20)||
    !Array.isArray(audit.receipts)||audit.receipts.length!==audit.attempts)return invalid();
  let total=0;
  const receipts=[];
  for(const [i,r] of audit.receipts.entries()){
    if(!isObject(r)||r.ordinal!==i+1||r.model!=="gpt-6-luna"||
      !bounded(r.reservedMicros,1,MAX_RESERVATION_MICROS)||!terminals.has(r.terminal)||
      !(r.upstreamStatus===null||bounded(r.upstreamStatus,100,599)))return invalid();
    total+=r.reservedMicros;
    if(total>MAX_RESERVATION_MICROS)return invalid();
    const row={ordinal:i+1,terminal:r.terminal,upstreamStatus:r.upstreamStatus};
    if(r.terminal==="provider_rejected"){
      if(!isObject(r.rejection))return invalid();
      const safe=safeProviderRejection(JSON.stringify({error:{
        type:short(r.rejection.type),code:short(r.rejection.code),param:short(r.rejection.param)}}));
      row.rejection={type:safe.type,code:safe.code,param:safe.param};
    }
    receipts.push(row);
  }
  if(total!==audit.reservedMicros)return invalid();
  return {...failed(head,"available"),attempts:audit.attempts,
    reservedUpperMicros:audit.reservedMicros,deniedCount:audit.deniedCount,
    policyDenials:audit.policyDenials.map(x=>safePolicyDenial(
      new Error("task14b_trusted_broker:"+short(x)))),receipts};
}

// The host-only audit path is not mounted into candidate Docker. Refuse
// symlinks, oversized files, nonregular files, stale heads and malformed JSON.
export function readFailureAudit(file,head){
  let fd;
  try{
    fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const s=fstatSync(fd);
    if(!s.isFile()||s.size>128*1024)return failed(head,"invalid");
    const bytes=readFileSync(fd);
    if(bytes.length>128*1024)return failed(head,"invalid");
    return projectFailureAudit(JSON.parse(bytes.toString("utf8")),head);
  }catch(e){return failed(head,e?.code==="ENOENT"?"missing":"invalid")}
  finally{if(fd!==undefined)closeSync(fd)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
  const dir=process.env.RUNNER_TEMP,head=process.env.HEAD_SHA;
  if(!dir||!dir.startsWith("/")||!shaRe.test(head??"")||process.env.GITHUB_RUN_ATTEMPT!=="1")
    throw Error("Invalid trusted failure diagnostic context");
  const result=readFailureAudit(join(dir,"luna-host-audit.json"),head);
  writeFileSync(join(dir,"luna-failure-diagnostic.json"),JSON.stringify(result,null,2)+"\n",
    {flag:"wx",mode:0o600});
}
