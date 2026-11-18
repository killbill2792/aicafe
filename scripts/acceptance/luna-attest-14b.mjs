// Trusted-host scenario attester extracted from .github/workflows/ai-cafe-14b-bounded-live.yml (main).
// Candidate source is never imported; host alone reads provider audit and local DB.
import {readFileSync,writeFileSync} from "node:fs";
const dir=process.env.RUNNER_TEMP;
const audit=JSON.parse(readFileSync(dir+"/task14b-host-audit.json","utf8"));
const proof=JSON.parse(readFileSync(dir+"/task14b-candidate-proof/task14b-live-proof.json","utf8"));
const observedTools=audit.receipts.flatMap(r=>
  Array.isArray(r.toolNames)?r.toolNames:[]);
if(!["inspect_supplier_purchase","propose_supplier_purchase_order",
     "get_supplier_purchase_orders"].every(t=>observedTools.includes(t)))
   throw Error("Trusted provider never selected the required multi-step tool chain");
if(audit.head!==process.env.HEAD_SHA||proof.headSha!==audit.head||
   proof.passed!==true||audit.attempts<3||audit.attempts>18||
   audit.reservedMicros<1||audit.reservedMicros>180_000||
   audit.receipts.length!==audit.attempts||
   audit.receipts.filter(r=>r.terminal==="completed"&&
     Number.isSafeInteger(r.actualInputTokens)&&r.actualInputTokens>0&&
     Number.isSafeInteger(r.actualOutputTokens)&&r.actualOutputTokens>=0).length<3||
   audit.receipts.some(r=>r.terminal!=="completed"||r.model!=="gpt-6-luna"))
  throw Error("Unverified Task14B real-model receipt / objective result");
const redacted={head:audit.head,model:"gpt-6-luna",
  providerAttempts:audit.attempts,
  upperCostReservationUSD:audit.reservedMicros/1_000_000,
  actualInputTokens:audit.receipts.reduce((n,r)=>n+r.actualInputTokens,0),
  actualOutputTokens:audit.receipts.reduce((n,r)=>n+r.actualOutputTokens,0),
  providerSelectedTools:observedTools,
  checks:proof.checks,realModelObjectivePassed:true,
  independentGrokMuseParity:"NOT_ATTESTED"};
writeFileSync(dir+"/task14b-sanitized-result.json",
  JSON.stringify(redacted,null,2)+"\n",{mode:0o600,flag:"wx"});
