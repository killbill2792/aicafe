import test from "node:test";
import assert from "node:assert/strict";
import {assessCoverage,requiredFamilies,verifyRoutineAndFile,verifyScheduledOccurrence} from "./task17c-oracle.mjs";
const head="a".repeat(40);
test("missing, stale or candidate-only receipt cannot pass",()=>{
 const base={family:"chat_routine",head,model:"gpt-6-luna",status:"PASS"};
 for(const receipt of [base,{...base,head:"b".repeat(40),providerAttested:true},
   {...base,providerAttested:true,sourceVerified:true,ownerVerified:true,effectVerified:true,negativeControlsVerified:true}])
  assert.equal(assessCoverage({head,inventoryFamilies:["chat_routine"],receipts:[receipt]}).rows.find(r=>r.family==="chat_routine").status,"NOT_PROVEN");
});
test("coverage rejects missing new registry family and retains a failure",()=>{
 const receipts=requiredFamilies.map(family=>({family,head,status:"PASS",model:"gpt-6-luna",
   providerAttested:true,sourceVerified:true,ownerVerified:true,effectVerified:true,negativeControlsVerified:true,executionArtifact:"trusted-fixture"}));
 assert.equal(assessCoverage({head,inventoryFamilies:[],receipts}).integratedProven,false);
 assert.equal(assessCoverage({head,inventoryFamilies:["new_supported_family"],receipts}).integratedProven,false);
 assert.equal(assessCoverage({head,inventoryFamilies:requiredFamilies,receipts}).integratedProven,true);
 assert.equal(assessCoverage({head,inventoryFamilies:requiredFamilies,receipts:[...receipts,{head,family:"chat_files",status:"FAIL"}]}).integratedProven,false);
});
const sample=()=>({scope:{businessId:"a",ownerUserId:"o",threadId:"t",attachmentId:"f"},
 expected:{title:"Review",timezone:"America/New_York",time:"08:12",reference:"ref-private",quantity:47},
 routines:[{id:"r",business_id:"a",owner_user_id:"o",thread_id:"t",title:"Review",cadence:"daily",timezone:"America/New_York",status:"active",local_time:"08:12:00",revision:1,weekdays:[]}],
 reply:[{structured_content:[{text:"Oat milk 47 ref-private"}]}],
 attachments:[{id:"f",business_id:"a",owner_user_id:"o",thread_id:"t"}],
 ownerRows:[{id:"msg"}],usage:{model:"gpt-6-luna",model_call_count:2,input_tokens:100},proposals:[],foreignRows:[]});
test("independent exact source and schedule assertions reject mutations",()=>{
 assert.equal(verifyRoutineAndFile(sample()),"r");
 for(const mutate of [x=>x.routines.push({...x.routines[0]}),x=>x.routines[0].local_time="09:12",
  x=>x.routines[0].business_id="foreign",x=>x.reply[0].structured_content=[{text:"Oat milk 470 ref-private"}],
  x=>x.proposals.push({id:"unexpected"}),x=>x.foreignRows.push({id:"leak"}),x=>x.usage.model="gpt-4.1-mini",
  x=>x.ownerRows.push({id:"new-owner-prompt"}),x=>x.attachments[0].owner_user_id="wrong"]){
  const x=sample();mutate(x);assert.throws(()=>verifyRoutineAndFile(x));
 }
});

test("separate worker ticks must complete and retain one stable occurrence",()=>{
 const row={run_id:"61361659-d37e-4408-8b4b-ea4325c3ebe8",local_date:"2026-11-19",revision:1,state:"completed",attempts:1,receipt_ref:"priority-check:1"};
 const good={expected:{localDate:row.local_date},firstPid:100,secondPid:200,before:[row],after:[{...row}]};
 assert.equal(verifyScheduledOccurrence(good),row.run_id);
 for(const mutate of [x=>x.before=[],x=>x.after[0].attempts=2,x=>x.secondPid=100,x=>x.before[0].state="pending",x=>x.after[0].run_id="changed",x=>x.before[0].receipt_ref=null]){
  const copy=structuredClone(good);mutate(copy);assert.throws(()=>verifyScheduledOccurrence(copy));
 }
});
