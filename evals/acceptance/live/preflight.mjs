import {createHash} from "node:crypto";
import {readFileSync,realpathSync,lstatSync} from "node:fs";
import {resolve,relative,isAbsolute,sep} from "node:path";

/** Paid/live acceptance is strictly local and explicit, never a preview or a production café. */
export const REQUIRED_PRODUCTION_SUPERVISOR_MODEL="gpt-6-luna"; // lib/ai/conversations/modelConfig.ts release contract
export function assertLocalLiveEnvironment(env){
 const fail=reason=>{throw new Error("live_preflight:"+reason);};
 const exact=(value,want)=>value===want||fail("non_disposable_endpoint");
 exact(env.AI_CAFE_LIVE_ACCEPTANCE,"OWNER_APPROVED_LOCAL_ONLY");
 if(env.SUPERVISOR_OPENAI_MODEL!==REQUIRED_PRODUCTION_SUPERVISOR_MODEL)
  fail("production_supervisor_model_required");
 exact(env.APP_URL,"http://127.0.0.1:3000");
 exact(env.NEXT_PUBLIC_SUPABASE_URL,"http://127.0.0.1:54321");
 if(env.VERCEL_URL||env.VERCEL_ENV||env.SUPABASE_PROJECT_REF)
  fail("hosted_environment_refused");
 const db=(()=>{try{return new URL(env.ACCEPTANCE_DATABASE_URL)}catch{return null}})();
 if(!db||!["postgres:","postgresql:"].includes(db.protocol)||
   db.hostname!=="127.0.0.1"||db.port!=="54322"||
   db.pathname!=="/postgres"||db.search||db.hash)
   fail("local_postgres_required");
 if(typeof env.OPENAI_API_KEY!=="string"||!/^sk-[A-Za-z0-9_-]{15,}$/.test(env.OPENAI_API_KEY)||
   env.OPENAI_API_KEY==="aicafe-disposable-e2e-no-provider")
   fail("real_provider_key_required");
 return {appUrl:env.APP_URL,dbUrl:env.ACCEPTANCE_DATABASE_URL,
  expectedModelId:REQUIRED_PRODUCTION_SUPERVISOR_MODEL};
}
const allowedMime=Object.freeze({
 ".jpeg":"image/jpeg",".jpg":"image/jpeg",".png":"image/png",
 ".webp":"image/webp",".pdf":"application/pdf"
});
const validId=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(x);
export function assertLiveManifest(manifest,{assetRoot,allowedOwners,minReceipts=50,minConversations=30}={}){
 const fail=reason=>{throw new Error("live_preflight:"+reason);};
 if(manifest?.schemaVersion!==1||manifest.datasetKind!=="human-labeled-holdout"||
   !validId(manifest.suiteId)||!manifest.reviewerApproval?.reviewerId||
   !Number.isFinite(Date.parse(manifest.reviewerApproval.approvedAt??"")))
   fail("independent_human_labels_required");
 if(!Array.isArray(manifest.cases)||manifest.cases.length===0||
   manifest.cases.length>200)fail("invalid_manifest_case_count");
 if(!(allowedOwners instanceof Map)||allowedOwners.size<2)fail("two_cafe_seed_required");
 if(typeof assetRoot!=="string"||!isAbsolute(assetRoot))
   fail("private_asset_root_required");
 const root=realpathSync(assetRoot);
 // No private original receipts are ever checked into this source repository.
 const repo=realpathSync(process.cwd());
 if(root===repo||root.startsWith(repo+sep))fail("assets_inside_repository");
 const ids=new Set(),receiptAssets=new Set(),conversationTexts=new Set();
 const prepared=[];
 for(const item of manifest.cases){
  if(!validId(item?.id)||ids.has(item.id))fail("duplicate_or_invalid_case");
  ids.add(item.id);
  if(!["receipt","conversation"].includes(item.category)||
   !validId(item.threadKey))fail("invalid_case_category_or_thread");
  const actor=allowedOwners.get(item.actor?.businessId);
  if(!actor||actor!==item.actor?.ownerId)fail("non_seed_owner_or_cafe");
  if(!item.input||typeof item.input.text!=="string"||
   !item.input.text.trim()||item.input.text.length>4000)
   fail("invalid_owner_instruction");
  if(!["updated","needs_review","no_action"].includes(item.expected?.outcome)||
   !Array.isArray(item.expected.writes)||!Array.isArray(item.expected.extracted)||
   !Number.isSafeInteger(item.expected.maxClarifications)||
   item.expected.maxClarifications<0||item.expected.maxClarifications>3)
   fail("missing_independent_expected_result");
  if(item.expected.outcome==="updated"&&item.expected.writes.length===0)
   fail("update_without_expected_purchase");
  if(item.expected.outcome!=="updated"&&item.expected.writes.length>0)
   fail("unapproved_expected_purchase");
  for(const write of item.expected.writes){
   if(!validId(write.sourceLineId)||!validId(write.ingredient)||
    !/^(g|ml|each)_x10000$/.test(write.unit)||
    !Number.isSafeInteger(write.delta)||write.delta<=0)
    fail("invalid_canonical_stock_delta");
   if(item.category==="receipt"&&
    (!Number.isSafeInteger(write.costCents)||write.costCents<0))
    fail("receipt_saved_cost_label_required");
   if(Object.hasOwn(write,"costCents")&&write.costCents!==null&&
    (!Number.isSafeInteger(write.costCents)||write.costCents<0))
    fail("invalid_purchase_cost_label");
  }
  const asset=item.input.assetSha256;
  if(item.category==="receipt"&&!asset)fail("receipt_asset_required");
  let file=null;
  if(asset!==null){
   if(typeof asset!=="string"||!/^[a-f0-9]{64}$/.test(asset)||
    !item.input.assetPath||isAbsolute(item.input.assetPath)||
    item.input.assetPath.split(/[\\/]/).includes(".."))
     fail("invalid_asset_reference");
   const resolved=resolve(root,item.input.assetPath);
   const real=realpathSync(resolved);
   if(!real.startsWith(root+sep)||lstatSync(resolved).isSymbolicLink())
     fail("asset_escapes_private_root");
   const extension=real.slice(real.lastIndexOf(".")).toLowerCase();
   const mime=allowedMime[extension];
   if(!mime)fail("unsupported_receipt_media");
   const raw=readFileSync(real);
   if(raw.length===0||raw.length>2*1024*1024)fail("receipt_size_rejected");
   const actual=createHash("sha256").update(raw).digest("hex");
   if(actual!==asset)fail("receipt_hash_mismatch");
   const signature= mime==="image/jpeg"?raw[0]===0xff&&raw[1]===0xd8&&raw[2]===0xff:
    mime==="image/png"?raw.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex")):
    mime==="image/webp"?raw.toString("ascii",0,4)==="RIFF"&&raw.toString("ascii",8,12)==="WEBP":
    raw.toString("ascii",0,5)==="%PDF-";
   if(!signature)fail("receipt_signature_mismatch");
   file={real,mime,raw};
   if(item.category==="receipt")receiptAssets.add(asset);
  }
  if(item.category==="conversation")conversationTexts.add(item.input.text);
  prepared.push({label:item,file});
 }
 const receipts=manifest.cases.filter(c=>c.category==="receipt").length,
  conversations=manifest.cases.length-receipts;
 if(receipts<minReceipts||conversations<minConversations)
  fail("insufficient_human_labeled_cases");
 if(receiptAssets.size<Math.ceil(minReceipts*.8)||
    conversationTexts.size<Math.ceil(minConversations*.8))
   fail("insufficient_independent_source_diversity");
 return prepared;
}
