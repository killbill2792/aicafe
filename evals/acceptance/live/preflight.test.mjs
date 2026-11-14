import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {assertLocalLiveEnvironment,assertLiveManifest} from "./preflight.mjs";

const local=()=>({AI_CAFE_LIVE_ACCEPTANCE:"OWNER_APPROVED_LOCAL_ONLY",
 APP_URL:"http://127.0.0.1:3000",
 NEXT_PUBLIC_SUPABASE_URL:"http://127.0.0.1:54321",
 ACCEPTANCE_DATABASE_URL:"postgres://postgres:local@127.0.0.1:54322/postgres",
 SUPERVISOR_OPENAI_MODEL:"gpt-6-luna",
 OPENAI_API_KEY:"sk-this_is_a_test_key_not_real"});
const owners=new Map([["business_alpha","owner_alpha"],["business_beta","owner_beta"]]);
const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489","hex");
function example(){
 const a=mkdtempSync(join(tmpdir(),"acceptance-private-"));
 writeFileSync(join(a,"bill.png"),png);
 const digest=createHash("sha256").update(png).digest("hex");
 const manifest={schemaVersion:1,suiteId:"private_holdout_v1",datasetKind:"human-labeled-holdout",
  reviewerApproval:{reviewerId:"owner_reviewer",approvedAt:"2026-11-13T00:00:00Z"},cases:[
   {id:"case_receipt",threadKey:"thread_a",category:"receipt",
    actor:{businessId:"business_alpha",ownerId:"owner_alpha"},
    input:{text:"Add my purchases.",assetPath:"bill.png",assetSha256:digest},
    expected:{outcome:"updated",maxClarifications:0,
     writes:[{sourceLineId:"line_1",ingredient:"whole_milk",delta:10000,unit:"ml_x10000",costCents:300}],extracted:[]}},
   {id:"case_chat",threadKey:"thread_b",category:"conversation",
    actor:{businessId:"business_beta",ownerId:"owner_beta"},
    input:{text:"Check if I already purchased milk.",assetSha256:null},
    expected:{outcome:"no_action",maxClarifications:1,writes:[],extracted:[]}}
  ]};
 return {root:a,manifest};
}
test("owner-authorized disposable environment only",()=>{
 assert.equal(assertLocalLiveEnvironment(local()).appUrl,"http://127.0.0.1:3000");
 for(const [name,value] of [
  ["APP_URL","https://staging.example.com"],
  ["NEXT_PUBLIC_SUPABASE_URL","https://project.supabase.co"],
  ["ACCEPTANCE_DATABASE_URL","postgres://postgres:test@database.example.com:5432/postgres"],
  ["ACCEPTANCE_DATABASE_URL","postgres://postgres:test@127.0.0.1:54322/postgres?host=remote"],
  ["OPENAI_API_KEY","aicafe-disposable-e2e-no-provider"],
  ["AI_CAFE_LIVE_ACCEPTANCE",""]
 ]){
  const env={...local(),[name]:value};
  assert.throws(()=>assertLocalLiveEnvironment(env),/live_preflight:/);
 }
 assert.throws(()=>assertLocalLiveEnvironment({...local(),VERCEL_URL:"preview.vercel.app"}),/hosted_environment/);
});
test("Luna acceptance fails closed on the 4.1 fallback or a missing model setting",()=>{
 const good=assertLocalLiveEnvironment(local());
 assert.equal(good.expectedModelId,"gpt-6-luna");
 for(const model of ["gpt-4.1-mini","gpt-6-luna-v2","",undefined]){
  const env=local();
  if(model===undefined)delete env.SUPERVISOR_OPENAI_MODEL;
  else env.SUPERVISOR_OPENAI_MODEL=model;
  assert.throws(()=>assertLocalLiveEnvironment(env),
   /live_preflight:production_supervisor_model_required/);
 }
});

test("independent human labels and original verified bytes required",()=>{
 const {root,manifest}=example();
 try{
  const result=assertLiveManifest(manifest,{assetRoot:root,allowedOwners:owners,
   minReceipts:1,minConversations:1});
  assert.equal(result.length,2);
  assert.deepEqual(result[0].file.raw,png);
  assert.throws(()=>assertLiveManifest(manifest,{assetRoot:root,allowedOwners:owners}),
   /insufficient_human_labeled_cases/);
  const changed=structuredClone(manifest);
  changed.cases[0].input.assetSha256="f".repeat(64);
  assert.throws(()=>assertLiveManifest(changed,{assetRoot:root,allowedOwners:owners,
   minReceipts:1,minConversations:1}),/receipt_hash_mismatch/);
  changed.cases[0].input.assetSha256=manifest.cases[0].input.assetSha256;
  changed.cases[0].actor.ownerId="another_owner";
  assert.throws(()=>assertLiveManifest(changed,{assetRoot:root,allowedOwners:owners,
   minReceipts:1,minConversations:1}),/non_seed_owner/);
  changed.cases[0].actor.ownerId="owner_alpha";
  changed.cases[0].expected.writes=[];
  assert.throws(()=>assertLiveManifest(changed,{assetRoot:root,allowedOwners:owners,
   minReceipts:1,minConversations:1}),/update_without_expected_purchase/);
 }finally{rmSync(root,{recursive:true,force:true})}
});
test("prevent path traversal, symlink bytes, fake label reviewers and repeated scenarios",()=>{
 const {root,manifest}=example();
 try{
  const assetPath=join(root,"link.png");
  symlinkSync(join(root,"bill.png"),assetPath);
  const changed=structuredClone(manifest);
  changed.cases[0].input.assetPath="link.png";
  assert.throws(()=>assertLiveManifest(changed,{assetRoot:root,allowedOwners:owners,
   minReceipts:1,minConversations:1}),/asset_escapes_private_root/);
  changed.cases[0].input.assetPath="../secret.png";
  assert.throws(()=>assertLiveManifest(changed,{assetRoot:root,allowedOwners:owners,
   minReceipts:1,minConversations:1}),/invalid_asset_reference/);
  changed.cases[0].input.assetPath="bill.png";
  changed.reviewerApproval=null;
  assert.throws(()=>assertLiveManifest(changed,{assetRoot:root,allowedOwners:owners,
   minReceipts:1,minConversations:1}),/independent_human_labels_required/);
  changed.reviewerApproval=manifest.reviewerApproval;
  changed.cases[1].id=changed.cases[0].id;
  assert.throws(()=>assertLiveManifest(changed,{assetRoot:root,allowedOwners:owners,
   minReceipts:1,minConversations:1}),/duplicate_or_invalid_case/);
 }finally{rmSync(root,{recursive:true,force:true})}
});
