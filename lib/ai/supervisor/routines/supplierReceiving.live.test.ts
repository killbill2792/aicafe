/** Task 14D autonomous acceptance. Separate bounded shared-Luna scenario:
 * real registered investigator and migrated disposable DB; Gmail transport
 * is controlled locally, never an actual supplier message. The browser
 * invoice/receipt owner journey remains in scenario 14d.
 */
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {existsSync,mkdirSync,mkdtempSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Client} from "pg";
import {createClient,type SupabaseClient} from "@supabase/supabase-js";
import {expect,it,vi} from "vitest";

vi.mock("server-only",()=>({}));
// Only the Next.js cookie boundary is replaced. Both sessions below are real,
// locally authenticated Supabase users and route membership/RLS stays intact.
const session=vi.hoisted(()=>({client:null as SupabaseClient|null,businessId:""}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>{
 if(!session.client)throw Error("14d_owner_session_required");
 return session.client;
}}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:async()=>session.businessId}));

import {openAIProvider,type AgentProvider} from "@/lib/ai/agent/loop.server";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {proposeLoop} from "@/lib/ai/supervisor/loop/engine";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
import {supplierInvoiceCapabilityId,supplierReceivingCapabilityId} from "@/lib/ai/supervisor/loop/supplierReceiving.server";
import {readSupplierReconciliation} from "@/lib/data/supplierReceiving.server";
import {encryptToken} from "@/lib/connectors/crypto.server";
import {GET,POST} from "@/app/api/ai/threads/[threadId]/proposals/route";
import {dispatchRoutinesForBusiness} from "./dispatch.server";
import {enqueueInvestigationsForOwner,processNextInvestigation,type InvestigationModelProofSummary} from "./investigation.server";

const enabled=process.env.AICAFE_SHARED_LUNA==="1"&&
 process.env.AICAFE_SHARED_LUNA_SCENARIO==="14d-autonomous"&&
 process.env.AI_CAFE_LIVE_ACCEPTANCE==="OWNER_APPROVED_LOCAL_ONLY";
const marker=process.env.AICAFE_14D_INTERRUPTED;
function local(value:string|undefined,kind:"db"|"api"){
 if(!value)throw Error("14d_missing_local_endpoint");
 const u=new URL(value);
 if(!["127.0.0.1","localhost"].includes(u.hostname)||
   u.protocol!==(kind==="db"?"postgresql:":"http:")||
   u.port!==(kind==="db"?"54322":"54321")||
   (kind==="db"&&u.pathname!=="/postgres"))throw Error("14d_non_disposable_endpoint");
 return value;
}
const options={auth:{persistSession:false,autoRefreshToken:false}};
async function until(check:()=>Promise<boolean>,timeout:number){
 const end=Date.now()+timeout;
 while(Date.now()<end){
  if(await check())return;
  await new Promise<void>(r=>setTimeout(r,250));
 }
 throw Error("14d_checkpoint_timeout");
}

// Kill a genuine worker AFTER the production pre-request usage reservation,
// BEFORE any paid transport. The replacement must recover the fenced lease.
(enabled&&marker?it:it.skip)("14d interrupted worker",async()=>{
 local(process.env.ACCEPTANCE_DATABASE_URL,"db");
 const api=local(process.env.NEXT_PUBLIC_SUPABASE_URL,"api");
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!key||!marker||configuredSupervisorModel()!=="gpt-6-luna")throw Error("14d_worker_configuration");
 const admin=createClient(api,key,options);
 expect(await processNextInvestigation(admin,new Date())).toMatchObject({collected:1,failed:0});
 const interrupted:AgentProvider=()=>({
  [Symbol.asyncIterator](){return {next:async()=>{
   writeFileSync(marker+".tmp",String(process.pid),{flag:"wx",mode:0o600});
   renameSync(marker+".tmp",marker);
   return await new Promise<never>((_r,reject)=>setTimeout(()=>reject(Error("14d_expected_kill")),240000));
  }};}
 });
 await processNextInvestigation(admin,new Date(),interrupted);
 throw Error("14d_interrupted_worker_returned");
},270000);

(enabled&&!marker?it:it.skip)("14d scheduled discrepancy, approved Gmail recovery and verified receiving closure",async()=>{
 const head=process.env.AICAFE_SHARED_LUNA_HEAD;
 if(!/^[a-f0-9]{40}$/.test(head??"")||configuredSupervisorModel()!=="gpt-6-luna"||!process.env.OPENAI_API_KEY)
  throw Error("14d_live_provider_or_head_missing");
 const api=local(process.env.NEXT_PUBLIC_SUPABASE_URL,"api");
 const url=local(process.env.ACCEPTANCE_DATABASE_URL,"db");
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY,anon=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 if(!key||!anon)throw Error("14d_local_keys_required");
 const db=createClient(api,key,options);
 const sql=new Client({connectionString:url});
 await sql.connect();
 const ids={business:randomUUID(),foreign:randomUUID(),thread:randomUUID(),supplier:randomUUID(),
  ingredient:randomUUID(),quote:randomUUID(),original:randomUUID(),po:randomUUID(),line:randomUUID(),
  contact:randomUUID(),account:randomUUID(),message:randomUUID()};
 const select=async(statement:string,args:unknown[]=[]) => (await sql.query(statement,args)).rows;
 const taskId="supplier-receiving:"+ids.po;
 const mailbox="owner@task14d.example",recipient="supplier@task14d.example";
 const calls:InvestigationModelProofSummary[]=[];
 let completions=0;
 const provider:AgentProvider=async function*(params,signal){
  if(params.model!=="gpt-6-luna"||typeof params.max_output_tokens!=="number")throw Error("14d_model_mismatch");
  for await(const ev of openAIProvider({...params,max_output_tokens:Math.min(params.max_output_tokens,1200)},signal)){
   if(ev.type==="response.completed"){
    if((ev.response as {model?:unknown}|undefined)?.model!=="gpt-6-luna")throw Error("14d_observed_model_mismatch");
    completions++;
   }
   yield ev;
  }
 };
 const oldKey=process.env.TOKEN_ENCRYPTION_KEY;
 let posts=0,reads=0,rfc="",allowRead=false;
 const providerId="task14d-local-sent",providerThread="task14d-local-thread";
 const realFetch=globalThis.fetch.bind(globalThis);
 // The fake mailbox accepts exactly one approved send, then loses the
 // response. Only the read-only RFC Message-ID reconciliation can recover it.
 const transport=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
  const address=new URL(input instanceof Request?input.url:String(input));
  if(address.hostname!=="gmail.googleapis.com")return realFetch(input,init);
  expect(address.pathname.startsWith("/gmail/v1/users/me/")).toBe(true);
  const method=init?.method??"GET";
  if(method==="POST"&&address.pathname.endsWith("/messages/send")){
   expect(++posts).toBe(1);
   const raw=JSON.parse(String(init?.body)).raw as string;
   const mime=Buffer.from(raw,"base64url").toString("utf8");
   expect(mime).toContain("To: "+recipient+"\r\n");
   rfc=/Message-ID: ([^\r\n]+)/.exec(mime)?.[1]??"";
   expect(rfc).toContain("@task14d.example>");
   throw Error("14d_controlled_response_lost");
  }
  if(method==="GET"&&address.pathname.endsWith("/messages")){
   reads++;
   expect(address.searchParams.get("q")).toBe("rfc822msgid:"+rfc);
   return Response.json({messages:allowRead?[{id:providerId}]:[]});
  }
  if(method==="GET"&&address.pathname.endsWith("/messages/"+providerId)){
   reads++;
   expect(allowRead).toBe(true);
   return Response.json({id:providerId,threadId:providerThread,labelIds:["SENT"],
    payload:{headers:[{name:"Message-ID",value:rfc}]}});
  }
  throw Error("14d_unexpected_gmail_transport");
 });
 try{
  // Independent, real locally-authenticated owner identities; no seed café
  // activity or production information enters this scenario.
  async function user(prefix:string){
   const email=prefix+"-"+randomUUID()+"@example.invalid",password="Local14d-"+randomUUID();
   const created=await db.auth.admin.createUser({email,password,email_confirm:true});
   if(created.error||!created.data.user)throw Error("14d_fixture_user_failed");
   const client=createClient(api,anon!,options);
   const logged=await client.auth.signInWithPassword({email,password});
   if(logged.error||logged.data.user?.id!==created.data.user.id)throw Error("14d_fixture_login_failed");
   return {id:created.data.user.id,client};
  }
  const owner=await user("receiving-owner"),foreign=await user("receiving-foreign");
  const scope={businessId:ids.business,ownerUserId:owner.id,threadId:ids.thread,locale:"en" as const};
  session.client=owner.client;session.businessId=ids.business;
  await sql.query("insert into public.businesses(id,name,timezone,currency,is_demo) values "+
   "($1,'14D disposable dairy cafe','America/Los_Angeles','USD',false),($2,'14D foreign cafe','Europe/London','GBP',false)",
   [ids.business,ids.foreign]);
  await sql.query("insert into public.cafe_access(business_id,mode) values($1,'grandfathered'),($2,'grandfathered') on conflict(business_id) do update set mode='grandfathered',access_end=null",[ids.business,ids.foreign]);
  await sql.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",[ids.business,owner.id,ids.foreign,foreign.id]);
  await sql.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",[ids.thread,ids.business,owner.id,randomUUID()]);
  const day=String((await select("select to_char((now() at time zone 'America/Los_Angeles')::date,'YYYY-MM-DD') d"))[0].d);
  const item="Task14D milk",supplier="Task14D disposable dairy";
  await sql.query("insert into public.cafe_suppliers(id,business_id,display_name) values($1,$2,$3)",[ids.supplier,ids.business,supplier]);
  await sql.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,$3,'ml')",[ids.ingredient,ids.business,item]);
  await sql.query("insert into public.ai_supplier_quotes(id,business_id,owner_user_id,client_request_id,supplier_name,item_name,ingredient_id,price_cents,package_count,package_unit,source_kind,quoted_on,currency_code) values($1,$2,$3,$4,$5,$6,$7,2000,10,'liter','supplier_quote',$8::date,'USD')",[ids.quote,ids.business,owner.id,randomUUID(),supplier,item,ids.ingredient,day]);
  const original={supplierName:supplier,currency:"USD",neededBy:day,subtotalCents:20000,totalCents:null,shippingCents:null,taxCents:null,limitations:["Freight and tax unknown"],lines:[{quoteId:ids.quote,ingredientId:ids.ingredient,itemName:item,neededBaseQuantity:100000,baseUnit:"ml",packs:10,packQuantity:10,packUnit:"liter",priceCents:2000,lineSubtotalCents:20000,quotedOn:day,deliveryOn:day}]};
  const hash=createHash("sha256").update(JSON.stringify(original)).digest("hex");
  await sql.query("insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status,revision) values($1,$2,$3,$4,$5,'maya.supplier_purchase_order.v1',1,$6::jsonb,$7,'{}','{\"durationDays\":1,\"metricScope\":\"supplier_purchase_order\"}','en','committed',4)",[ids.original,ids.business,owner.id,ids.thread,randomUUID(),JSON.stringify(original),hash]);
  await sql.query("insert into public.purchase_orders(id,business_id,owner_user_id,supplier_id,supplier_name_snapshot,proposal_id,effect_hash,status,revision,currency_code,subtotal_cents,needed_by) values($1,$2,$3,$4,$5,$6,$7,'approved_for_ordering',1,'USD',20000,$8::date)",[ids.po,ids.business,owner.id,ids.supplier,supplier,ids.original,hash,day]);
  await sql.query("insert into public.purchase_order_lines(id,business_id,purchase_order_id,quote_id,ingredient_id,ordinal,item_name_snapshot,needed_base_quantity,base_unit,packs,pack_quantity,pack_unit,unit_price_cents,subtotal_cents,quoted_on,delivery_on) values($1,$2,$3,$4,$5,1,$6,100000,'ml',10,10,'liter',2000,20000,$7::date,$7::date)",[ids.line,ids.business,ids.po,ids.quote,ids.ingredient,item,day]);
  await sql.query("insert into public.cafe_supplier_order_contacts(id,business_id,supplier_id,owner_user_id,channel,email,verified_at) values($1,$2,$3,$4,'gmail',$5,now())",[ids.contact,ids.business,ids.supplier,owner.id,recipient]);
  await sql.query("insert into public.connector_accounts(id,business_id,owner_user_id,provider,provider_subject,email,granted_scopes,enabled_operations,status,generation) values($1,$2,$3,'gmail',$4,$5,array['https://www.googleapis.com/auth/gmail.modify']::text[],array['read','send']::text[],'active',1)",[ids.account,ids.business,owner.id,ids.account,mailbox]);
  process.env.TOKEN_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  await sql.query("insert into public.connector_credentials(account_id,access_token_enc,refresh_token_enc,token_expires_at,generation) values($1,$2,$3,now()+interval '1 day',1)",[ids.account,encryptToken("local-14d-token"),encryptToken("local-14d-refresh")]);
  const repo=new SupabaseLoopRepository();
  const path="http://127.0.0.1:3000/api/ai/threads/"+ids.thread+"/proposals";
  const params={params:Promise.resolve({threadId:ids.thread})};
  const action=(proposalId:string,revision:number,action:"approve"|"reconcile")=>POST(new Request(path,{method:"POST",headers:{origin:"http://127.0.0.1:3000","content-type":"application/json"},body:JSON.stringify({action,proposalId,revision})}),params);
  const view=(id:string)=>GET(new Request(path+"?ids="+id),params);
  const save=async(capability:string,input:unknown)=>{
   const p=await proposeLoop({...scope,verifiedReadClient:owner.client},supervisorLoopRegistry,repo,capability,input,randomUUID());
   expect(p.status).toBe("draft");
   expect((await action(p.id,p.revision,"approve")).status).toBe(200);
   const saved=await repo.load(scope,p.id);
   expect(saved.status).toBe("committed");
   return saved;
  };
  // Real owner source fixture + actual approval route, not a model claim.
  const reported="Supplier invoice for 100 litres of milk, USD 200, zero tax, freight and discount.";
  await sql.query("insert into public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content) values($1,$2,$3,$4,$3,'owner','text',$5)",[ids.message,ids.business,owner.id,ids.thread,reported]);
  const invoice=await save(supplierInvoiceCapabilityId,{purchaseOrderId:ids.po,invoiceReference:"14d-invoice-"+ids.po,expectedInvoiceRevision:0,issuedOn:day,dueOn:null,currency:"USD",subtotalCents:20000,taxCents:0,freightCents:0,discountCents:0,totalCents:20000,lines:[{orderLineId:ids.line,sourceItemName:item,quantityBase4:1000000000,subtotalCents:20000}],expenseDate:null,existingExpenseId:null,sourceKind:"owner_report",sourceRef:"owner-message:"+ids.message,sourceSha256:createHash("sha256").update(reported).digest("hex")});
  const receiving=(ref:string,ml:number)=>save(supplierReceivingCapabilityId,{purchaseOrderId:ids.po,receivingReference:ref,receivedOn:day,expectedReceiptRevision:0,lines:[{orderLineId:ids.line,receivedBase4:ml*10000,acceptedBase4:ml*10000,damagedBase4:0}]});
  const first=await receiving("14d-first-"+ids.po,60000);
  const reconciliation=await readSupplierReconciliation(db,ids.business,owner.id,ids.po);
  expect(reconciliation.reconciliation?.issues).toContain("short_delivery");
  expect(reconciliation.reconciliation?.closureVerified).toBe(false);
  const count=(table:"pantry_stock_purchases"|"expenses"|"connector_provider_receipts"|"ai_messages",extra="")=>select("select count(*)::int n from public."+table+" where business_id=$1 "+extra,[ids.business]).then(r=>Number(r[0].n));
  expect(await count("pantry_stock_purchases")).toBe(1);
  expect(await count("expenses")).toBe(0);
  const ownerBefore=await count("ai_messages","and role='owner'");
  const dispatch=()=>dispatchRoutinesForBusiness(db,ids.business,"America/Los_Angeles",new Date(),enqueueInvestigationsForOwner);
  expect((await dispatch()).investigationsQueued).toBeGreaterThanOrEqual(1);
  const checkpoint=async()=> (await select("select episode_id,phase,step_version,lease_token,evidence,lease_until<=clock_timestamp() expired from public.supervisor_investigations where business_id=$1 and source_id=$2",[ids.business,taskId]))[0];
  const episode=(await checkpoint()).episode_id;
  const dir=mkdtempSync(join(tmpdir(),"14d-worker-")),file=join(dir,"held");
  const child=spawn(process.execPath,["node_modules/vitest/vitest.mjs","run","lib/ai/supervisor/routines/supplierReceiving.live.test.ts","--pool=threads","--maxWorkers=1"],{detached:true,stdio:"ignore",env:{...process.env,AICAFE_14D_INTERRUPTED:file}});
  const exit=once(child,"exit");void exit.catch(()=>{});
  try{
   await until(async()=>{
    if(child.exitCode!==null||child.signalCode!==null)throw Error("14d_worker_exited_before_claim");
    return existsSync(file);
   },45000);
   const held=await checkpoint();
   expect(held).toMatchObject({episode_id:episode,phase:"investigate"});
   expect(held.lease_token).toBeTruthy();
   expect((await select("select count(*)::int n from public.supervisor_system_usage_events where business_id=$1 and status='attempted'",[ids.business]))[0].n).toBe(1);
   if(!child.pid)throw Error("14d_child_pid_missing");
   process.kill(-child.pid,"SIGKILL");
   expect(await exit).toEqual([null,"SIGKILL"]);
   await until(async()=>{
    const row=await checkpoint();
    if(row.lease_token!==held.lease_token)throw Error("14d_lease_changed_before_recovery");
    return row.expired===true;
   },195000);
  }finally{
   if(child.pid&&child.exitCode===null&&child.signalCode===null){process.kill(-child.pid,"SIGKILL");await exit;}
   rmSync(dir,{recursive:true,force:true});
  }
  expect(await processNextInvestigation(db,new Date(),provider,x=>calls.push(x))).toMatchObject({investigated:1,failed:0});
  const pending=await checkpoint();
  expect(pending).toMatchObject({episode_id:episode,phase:"awaiting_owner"});
  expect(pending.evidence.modelTools).toContain("get_investigation_source");
  expect(pending.evidence.modelTools).toContain("inspect_purchase_reconciliation");
  expect(pending.evidence.modelTools).toContain("propose_supplier_discrepancy_followup");
  expect(pending.evidence.modelTools.some((t:string)=>["get_inventory","get_expenses","get_bills"].includes(t))).toBe(true);
  const proposalId=String(pending.evidence.receivingFollowupProposalId??"");
  expect(proposalId).toMatch(/^[a-f0-9-]{36}$/);
  const draft=await repo.load(scope,proposalId);
  expect(draft).toMatchObject({status:"draft",capabilityId:"alex.gmail_effect.v1",canonicalEffectPayload:{to:[recipient],supplierFollowup:{purchaseOrderId:ids.po,contactId:ids.contact,poRevision:1,receiptVersions:1,invoiceVersions:1}}});
  const ownerNotice=(await select("select id from public.ai_messages where business_id=$1 and thread_id=$2 and role='supervisor' and structured_content @> $3::jsonb",[ids.business,ids.thread,JSON.stringify([{type:"proposal_card",proposalId}])]));
  expect(ownerNotice).toHaveLength(1);
  const preview=await view(proposalId);
  expect(preview.status).toBe(200);
  expect((await preview.json()).cards).toEqual([expect.objectContaining({proposalId,state:"pending",to:[recipient]})]);
  expect(await count("ai_messages","and role='owner'")).toBe(ownerBefore);
  expect(await count("connector_provider_receipts")).toBe(0);
  expect(posts).toBe(0);
  // Foreign owner cannot read OR approve the actual card or its source.
  session.client=foreign.client;session.businessId=ids.foreign;
  expect((await view(proposalId)).status).not.toBe(200);
  expect((await action(proposalId,draft.revision,"approve")).status).not.toBe(200);
  const foreignRead=await foreign.client.from("purchase_receipts").select("id").eq("business_id",ids.business).eq("purchase_order_id",ids.po);
  expect(foreignRead.error).toBeNull();expect(foreignRead.data).toEqual([]);
  expect(posts).toBe(0);
  session.client=owner.client;session.businessId=ids.business;
  // Click is explicit; lost response remains uncertain. A second click never
  // sends again, and a missing provider search must not claim success.
  expect((await action(proposalId,draft.revision,"approve")).status).toBe(409);
  const uncertain=await repo.load(scope,proposalId);
  expect(uncertain.status).toBe("executing");expect(posts).toBe(1);
  expect((await action(proposalId,draft.revision,"approve")).status).toBe(409);
  expect((await action(proposalId,uncertain.revision,"reconcile")).status).toBe(409);
  expect(posts).toBe(1);
  allowRead=true;
  expect((await action(proposalId,uncertain.revision,"reconcile")).status).toBe(200);
  expect((await repo.load(scope,proposalId)).status).toBe("committed");
  expect(posts).toBe(1);expect(reads).toBeGreaterThanOrEqual(2);
  expect(await count("connector_provider_receipts")).toBe(1);
  expect((await select("select state,provider_message_id from public.connector_provider_receipts where business_id=$1 and proposal_id=$2",[ids.business,proposalId]))).toEqual([{state:"verified",provider_message_id:providerId}]);
  expect((await checkpoint()).phase).toBe("awaiting_owner");
  expect((await readSupplierReconciliation(db,ids.business,owner.id,ids.po)).reconciliation?.closureVerified).toBe(false);
  expect(await count("pantry_stock_purchases")).toBe(1);expect(await count("expenses")).toBe(0);
  // A later actual physical installment is independently approved. The same
  // scheduler detects new evidence and the model must reread canonical sources.
  const second=await receiving("14d-second-"+ids.po,40000);
  expect((await readSupplierReconciliation(db,ids.business,owner.id,ids.po)).reconciliation?.closureEvidenceReady).toBe(true);
  await dispatch();
  for(let i=0;i<4&&(await checkpoint()).phase!=="resolved";i++){
   const tick=await processNextInvestigation(db,new Date(),provider,x=>calls.push(x));
   expect(tick.failed).toBe(0);
   if(!tick.processed)throw Error("14d_changed_source_not_due");
  }
  const closed=await checkpoint();
  expect(closed.phase).toBe("resolved");
  const proof=(await readSupplierReconciliation(db,ids.business,owner.id,ids.po)).reconciliation;
  expect(proof).toMatchObject({closureVerified:true,closureEvidenceReady:true,paidCents:null,issues:[]});
  expect((await select("select status from public.operating_tasks where business_id=$1 and id=$2",[ids.business,taskId]))).toEqual([{status:"handled"}]);
  const stock=await select("select quantity_base from public.pantry_stock_purchases where business_id=$1 and ingredient_id=$2 and voided_at is null order by quantity_base",[ids.business,ids.ingredient]);
  expect(stock.map(r=>Number(r.quantity_base))).toEqual([40000,60000]);
  expect(await count("expenses")).toBe(0);expect(posts).toBe(1);
  expect(await count("ai_messages","and role='owner'")).toBe(ownerBefore);
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls.every(x=>x.verified&&!x.externalEffectClaim&&x.unverifiedCount===0)).toBe(true);
  const usage=await select("select model,status,input_tokens from public.supervisor_system_usage_events where business_id=$1",[ids.business]);
  expect(usage.filter(r=>r.status==="attempted")).toHaveLength(1);
  const finished=usage.filter(r=>r.status==="completed");
  expect(finished).toHaveLength(completions);
  expect(finished.every(r=>r.model==="gpt-6-luna"&&Number(r.input_tokens)>0)).toBe(true);
  expect(completions).toBeGreaterThanOrEqual(4);
  mkdirSync("test-results/acceptance",{recursive:true});
  writeFileSync("test-results/acceptance/14d-autonomous-proof.json",JSON.stringify({schema_version:1,id:"14d-autonomous",head_sha:head,status:"passed",observed_model:"gpt-6-luna",modelCalls:completions,actualWorkerKilled:true,actualLeaseExpiry:true,controlledGmailSend:true,realExternalGmailDelivery:false,verifiedClosure:true},null,2)+"\n",{mode:0o600});
  writeFileSync("test-results/acceptance/14d-autonomous-scope.json",JSON.stringify({businessId:ids.business,otherCafeId:ids.foreign,ownerUserId:owner.id,threadId:ids.thread,poId:ids.po,taskId,episodeId:closed.episode_id,proposalId,ownerNoticeId:ownerNotice[0].id,invoiceProposalId:invoice.id,firstProposalId:first.id,secondProposalId:second.id,expectedProviderCalls:completions},null,2)+"\n",{mode:0o600});
 }finally{
  transport.mockRestore();
  if(oldKey===undefined)delete process.env.TOKEN_ENCRYPTION_KEY;else process.env.TOKEN_ENCRYPTION_KEY=oldKey;
  session.client=null;session.businessId="";
  await sql.end();
 }
},480000);
