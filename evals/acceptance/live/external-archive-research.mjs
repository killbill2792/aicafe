#!/usr/bin/env node
/** Real model acceptance on the shared runner's disposable café database. */
import {randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";
import {resolveProofPaths} from "./sql-research.mjs";
import {login,matchedCount,observedProviderCalls,ownerTurn} from "./u3-canonical-research.mjs";

const id="external-archive-research";
const resource="inventory/items";
const sourceKey="damson-roast";
const fail=reason=>{throw Error("external_archive_research:"+reason);};
const rows=async(db,sql,params=[])=>(await db.query(sql,params)).rows;

export async function seedExternalArchiveCase(db,businessId,otherCafeId,account){
  for(const [cafe,quantities] of [[businessId,[713,217]],[otherCafeId,[98741,56428]]]){
    for(const [revision,quantity] of quantities.entries()){
      await db.query("select public.external_commit_page($1,'clover',$2,$3,'inventory',$4,null,true,$5::jsonb)",
        [cafe,account,resource,revision,JSON.stringify([{key:sourceKey,payload:{
          id:sourceKey,name:"Damson Roast",inventory:{"unit count":quantity,restockHint:null},
        }}])]);
    }
  }
  await db.query("select public.external_note_availability($1,'clover',$2,$3,'unavailable',clock_timestamp(),null)",
    [businessId,account,resource]);
}

/** Independent oracle. It reads the current body, history, and availability. */
export async function readExternalArchiveCase(db,businessId,otherCafeId,account){
  const evidence=await rows(db,`select r.id,r.business_id,r.payload_sha256,e.status,e.last_complete_at,
    (r.payload #>> '{inventory,unit count}')::int as quantity,
    r.payload #> '{inventory,restockHint}'='null'::jsonb as explicit_null,
    (r.payload->'inventory') ? 'lotNote' as has_lot_note,
    (change->>'before')::int as previous,(change->>'after')::int as revised
    from public.external_records r join public.external_resources e
      on (r.business_id,r.provider,r.source_account,r.entity)=(e.business_id,e.provider,e.source_account,e.resource)
    join public.external_record_changes c on (c.business_id,c.provider,c.record_id)=(r.business_id,r.provider,r.id)
    cross join lateral jsonb_array_elements(c.changes) change
    where r.business_id in ($1,$2) and r.provider='clover' and r.source_account=$3
      and r.entity=$4 and r.source_key=$5 and change->'segments'='["inventory","unit count"]'
    order by r.business_id`,[businessId,otherCafeId,account,resource,sourceKey]);
  const owner=evidence.find(row=>row.business_id===businessId),other=evidence.find(row=>row.business_id===otherCafeId);
  if(evidence.length!==2||owner?.status!=="unavailable"||other?.status!=="current"||
    evidence.some(row=>row.quantity!==row.revised||row.previous===row.revised||!row.last_complete_at||
      !row.explicit_null||row.has_lot_note!==false))fail("independent_archive_oracle_missing");
  return {owner,other};
}

export function assertExternalArchiveAnswer({model,tools,text,owner,other}){
  requireObservedProductionModel(model,"gpt-6-luna");
  if(!["describe_database","run_sql"].every(tool=>tools.includes(tool)))fail("registered_research_tools_missing");
  const line=(label)=>text.match(new RegExp("^[-* \\t]*(?:"+label+")[* \\t]*:[* \\t]*([^\\n]+)","im"))?.[1]??"";
  if(!matchedCount(line("Previous observed quantity"),owner.previous)||
    !matchedCount(line("Last observed quantity"),owner.quantity)||
    [other.previous,other.quantity].some(quantity=>matchedCount(text,quantity)))fail("archive_revision_or_scope_mismatch");
  if(!/unavailable|stale|unable to (?:verify|refresh)|could not (?:verify|refresh)|not current/i.test(line("Sync status")))
    fail("unavailable_current_stock_not_disclosed");
  if(!/\bnull\b/i.test(line("`?restockHint`?"))||
    !/missing|absent|omitted|not (?:included|present|provided|returned)/i.test(line("`?lotNote`?")))
    fail("null_and_missing_not_distinguished");
}

async function main(){
  const env=process.env;
  if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!==id)
    fail("explicit_shared_luna_authorization_required");
  assertLocalLiveEnvironment(env);
  verifyCheckoutHead(env.HEAD_SHA);
  const {out,scopeOut}=resolveProofPaths(process.argv.slice(2),env,id);
  const [cafe,foreignCafe]=TEST_CAFES;
  const businessId=cafe.businessId,otherCafeId=foreignCafe.businessId;
  const account="acceptance-"+randomUUID();
  const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
  const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
  const browser=await chromium.launch({headless:true});
  let owner,foreign;
  try{
    await db.connect();
    await seedExternalArchiveCase(db,businessId,otherCafeId,account);
    const before=await readExternalArchiveCase(db,businessId,otherCafeId,account);
    owner=await login(browser,cafe);
    const response=await owner.context.request.post("/api/ai/threads",{
      headers:{Origin:"http://127.0.0.1:3000"},
      data:{requestId:randomUUID(),title:"External archive research acceptance"},
    });
    if(response.status()!==201)fail("thread_creation_failed");
    const threadId=(await response.json()).thread?.id;
    if(!threadId)fail("thread_missing");
    const turn=await ownerTurn(owner.page,threadId,
      "What does our Clover source show for Damson Roast? Find the source in the database and report the previous and last observed unit counts, "+
      "whether the latest sync verifies current stock, and what Clover supplied for restockHint and lotNote. Use one line per field, "+
      "with these labels followed by a colon: Previous observed quantity, Last observed quantity, Sync status, restockHint, lotNote. This is research only.");
    const replyId=turn.done.reply.id;
    const [message]=await rows(db,"select id from public.ai_messages where business_id=$1 and thread_id=$2 "+
      "and client_message_id=$3 and role='owner'",[businessId,threadId,turn.clientMessageId]);
    const [reply]=await rows(db,"select structured_content from public.ai_messages where business_id=$1 "+
      "and thread_id=$2 and id=$3 and role='supervisor'",[businessId,threadId,replyId]);
    if(!message||!Array.isArray(reply?.structured_content))fail("persisted_owner_turn_missing");
    if(reply.structured_content.some(block=>["proposal_card","experiment_card"].includes(block.type)))fail("unexpected_effect_card");
    const text=reply.structured_content.filter(block=>block.type==="text").map(block=>block.text).join("\n");
    const usage=await readPersistedModelUsage(db,businessId,message.id);
    assertExternalArchiveAnswer({model:usage.model,tools:turn.names,text,...before});
    foreign=await login(browser,foreignCafe);
    const denied=await foreign.context.request.get("/api/ai/threads/"+threadId);
    if(![401,403,404].includes(denied.status()))fail("cross_cafe_thread_visible");
    const [effects]=await rows(db,"select count(*)::int as n from public.supervisor_proposals where business_id=$1 and thread_id=$2",
      [businessId,threadId]);
    if(effects.n!==0||JSON.stringify(before)!==JSON.stringify(await readExternalArchiveCase(db,businessId,otherCafeId,account)))
      fail("research_changed_source_or_created_effect");
    const expectedProviderCalls=observedProviderCalls(usage);
    writeFileSync(out,JSON.stringify({id,schema_version:1,head_sha:env.HEAD_SHA,status:"passed",observed_model:usage.model,
      observedModelCalls:expectedProviderCalls,checks:{previousAndObserved:true,missingAndNull:true,unavailable:true,
        providerRecordUnchanged:true,foreignDenied:true,noProposal:true}})+"\n",{mode:0o600,flag:"wx"});
    writeFileSync(scopeOut,JSON.stringify({businessId,otherCafeId,account,resource,sourceKey,threadId,replyId,
      sourceRecordId:before.owner.id,foreignRecordId:before.other.id,expectedProviderCalls})+"\n",{mode:0o600,flag:"wx"});
  }finally{
    for(const close of [()=>foreign?.context.close(),()=>owner?.context.close(),()=>browser.close(),()=>db.end()])
      await Promise.resolve().then(close).catch(()=>{});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(error instanceof Error?error.message:"external_archive_research:unknown");process.exitCode=1;});
