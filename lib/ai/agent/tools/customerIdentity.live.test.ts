import {randomUUID,createHash} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {Client} from "pg";
import {createClient} from "@supabase/supabase-js";
import {emptyInvestigationLiveLedger,reserveInvestigationLiveCall}
  from "@/lib/ai/supervisor/routines/investigation.liveBudget";
import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {runAgentTurn,openAIProvider,type AgentProvider} from "@/lib/ai/agent/loop.server";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {processDueInvestigations,
  type InvestigationModelProofSummary} from "@/lib/ai/supervisor/routines/investigation.server";
import type {AgentToolContext} from "./index";
const scenario=process.env.AICAFE_SHARED_LUNA_SCENARIO==="pos0ef-customer-trends"?
 "pos0ef-customer-trends":"pos0ef-customer-identity";
const enabled=process.env.AICAFE_SHARED_LUNA==="1"&&process.env.AICAFE_SHARED_LUNA_SCENARIO===scenario&&process.env.AI_CAFE_LIVE_ACCEPTANCE==="OWNER_APPROVED_LOCAL_ONLY";
const live=enabled?it:it.skip;
const requireLocal=(value:string|undefined,kind:"db"|"api"):string=>{
  if(!value)throw new Error("15A live test requires "+kind+" config");
  const u=new URL(value);
  if(!["127.0.0.1","localhost"].includes(u.hostname)||
    u.protocol!==(kind==="db"?"postgresql:":"http:")||
    u.port!==(kind==="db"?"54322":"54321")||
    (kind==="db"&&u.pathname!=="/postgres"))
    throw new Error("15A live test refuses non-local or non-disposable endpoints");
  return value;
};

import {refreshBusinessAnomalies} from "@/lib/alerts/businessAnomalies.server";
live("retained customer identity or observed trend, real model investigation, isolation and source correction",async()=>{
 const head=process.env.AICAFE_SHARED_LUNA_HEAD;
 if(!/^[a-f0-9]{40}$/.test(head??"")||configuredSupervisorModel()!=="gpt-6-luna"||!process.env.OPENAI_API_KEY||!process.env.SUPABASE_SERVICE_ROLE_KEY)
   throw Error("15a_live_configuration");
 const admin=new Client({connectionString:requireLocal(process.env.ACCEPTANCE_DATABASE_URL,"db")});
 await admin.connect();
 const db=createClient(requireLocal(process.env.NEXT_PUBLIC_SUPABASE_URL,"api"),process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const businessId=randomUUID(),ownerUserId=randomUUID(),threadId=randomUUID(),foreignBusinessId=randomUUID(),foreignOwnerId=randomUUID();
 const scope={businessId,ownerUserId,threadId};
 const now=new Date(),today=now.toISOString().slice(0,10);
 let ledger=emptyInvestigationLiveLedger(),providerCompletions=0;
 const proofs:InvestigationModelProofSummary[]=[];
 const capture=(p:InvestigationModelProofSummary)=>proofs.push(p);
 const provider:AgentProvider=async function*(params,signal){
  if(params.model!=="gpt-6-luna"||typeof params.max_output_tokens!=="number")throw Error("15a_live_model");
  const bounded={...params,max_output_tokens:Math.min(params.max_output_tokens,1200)};
  ledger=reserveInvestigationLiveCall(ledger,Buffer.byteLength(JSON.stringify(bounded),"utf8"),bounded.max_output_tokens,params.model);
  for await(const event of openAIProvider(bounded,signal)){
   if(event.type==="response.completed"){
    if((event.response as {model?:unknown})?.model!=="gpt-6-luna")throw Error("15a_live_model_mismatch");
    providerCompletions++;
   }
   yield event;
  }
 };
 try{
  for(const [business,owner] of [[businessId,ownerUserId],[foreignBusinessId,foreignOwnerId]]){
   await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[owner,owner+"@example.invalid"]);
   await admin.query("insert into public.businesses(id,name,timezone,currency,is_demo) values($1,'Disposable customer evidence cafe','UTC','USD',false)",[business]);
   await admin.query("insert into public.cafe_access(business_id,mode) values($1,'grandfathered') on conflict (business_id) do update set mode='grandfathered',access_end=null",[business]);
   await admin.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner')",[business,owner]);
  }
  await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",[threadId,businessId,ownerUserId,randomUUID()]);
  const restaurant=randomUUID(),foreignRestaurant=randomUUID();
  const date=(offset:number)=>new Date(now.getTime()+offset*86400000).toISOString().slice(0,10);
  for(const [cafe,rest] of [[businessId,restaurant],[foreignBusinessId,foreignRestaurant]]){
   const location=randomUUID();
   await admin.query("insert into public.locations(id,business_id,name) values($1,$2,\'Fixture location\')",[location,cafe]);
   await admin.query("select public.toast_save_configuration($1,\'https://ws-api.toasttab.com\',\'synthetic_client\',\'synthetic_ciphertext\',jsonb_build_array(jsonb_build_object(\'location_id\',$2::uuid,\'restaurant_guid\',$3::uuid)))",[cafe,location,rest]);
  }
  if(scenario==="pos0ef-customer-trends"){
   // Source-backed positive control: 35 linked account references, each
   // observed once in each complete closed week. No generated alert is seeded.
   const run=randomUUID(),product=randomUUID();
   const ids=Array.from({length:35},()=>randomUUID());
   const receipts:Array<{day:string;order:string;check:string;guest:string;line:string;current:boolean}>=[];
   await admin.query("insert into public.toast_sync_runs(id,business_id,restaurant_guid,kind,state) values($1,$2,$3,'backfill','running')",[run,businessId,restaurant]);
   await admin.query("insert into public.menu_items(business_id,name,base_name,price_cents,pos_item_id) values($1,'Fixture latte','Fixture latte',700,$2)",[businessId,"toast:"+restaurant+":"+product]);
   for(let offset=-14;offset<0;offset++){
    const day=date(offset);
    await admin.query("insert into public.toast_day_status(business_id,restaurant_guid,business_date,import_state,recon_state,coverage_complete,unparsed_count,last_import_run_id) values($1,$2,$3,'imported','checked_internal',true,0,$4)",[businessId,restaurant,day,run]);
    for(let k=0;k<5;k++){
     const guest=ids[((offset+14)%7)*5+k],order=randomUUID(),check=randomUUID(),line=randomUUID();
     const payload={guid:order,source:"POS",checks:[{guid:check,amount:7,customer:{guid:guest,firstName:"Fixture",lastName:"Guest"},payments:[],selections:[{guid:line,item:{guid:product},displayName:"Fixture latte",quantity:1,price:7}]}]};
     const text=JSON.stringify(payload);
     await admin.query("insert into public.toast_raw_records(business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key,run_id) values($1,$2,'order',$3,$4,$5,$6,$7)",[businessId,restaurant,day,text,createHash("sha256").update(text).digest("hex"),"trend:"+order,run]);
     receipts.push({day,order,check,guest,line,current:offset>=-7});
    }
    // Independent business-domain evidence for the worker, not a customer
    // trend inferred from the synthetic menu price or staffing alone.
    await admin.query("insert into public.daily_rollups(business_id,business_date,net_sales_cents,orders_count,drinks_count,ingredients_cents,staff_wages_cents,staff_tax_cents,card_fees_cents,voids_cents,sales_data_status) values($1,$2,3500,5,5,500,1000,100,0,0,'actual')",[businessId,day]);
   }
   // Independent fixture oracle derives raw guest sets, visit counts and
   // cents, not expected numbers copied out of the canonical function.
   const previous=new Set(receipts.filter(r=>!r.current).map(r=>r.guest));
   const current=receipts.filter(r=>r.current);
   expect(previous.size).toBe(35);expect(current).toHaveLength(35);
   expect(current.filter(r=>previous.has(r.guest))).toHaveLength(35);
   const expected={references:new Set(receipts.map(r=>r.guest)).size,visits:receipts.length,
    returning:current.filter(r=>previous.has(r.guest)).length,net:receipts.length*700};
   const records=await admin.query("select count(*)::int n from public.toast_raw_records where business_id=$1 and entity='order'",[businessId]);
   expect(records.rows[0].n).toBe(expected.visits);
   // The real registered Supervisor model uses an actual scoped owner JWT,
   // not the privileged service-role query client. Create a second exact
   // disposable owner login and use the existing authorization predicate.
   const password=randomUUID()+randomUUID();
   const login=await db.auth.admin.createUser({email:randomUUID()+"@example.invalid",password,email_confirm:true});
   if(login.error||!login.data.user||!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)throw Error("customer_owner_login");
   const queryOwnerId=login.data.user.id;
   await admin.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner')",[businessId,queryOwnerId]);
   const ownerDb=createClient(requireLocal(process.env.NEXT_PUBLIC_SUPABASE_URL,"api"),process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {auth:{persistSession:false,autoRefreshToken:false}});
   const signed=await ownerDb.auth.signInWithPassword({email:login.data.user.email!,password});
   if(signed.error)throw Error("customer_owner_sign_in");
   const context={asOf:today,timezone:"UTC",currency:"USD",locale:"en",tools:{} as AgentToolContext["tools"],
    canonicalData:async()=>({db:ownerDb,businessId})} as AgentToolContext;
   const turn=await runAgentTurn({context,provider,toolNames:["query_data","describe_data"],
    ownerText:"From "+date(-14)+" through "+date(-1)+", using the retained customer evidence, how many distinct observed account references, linked order visits, returning linked visits, and net sales in integer cents were recorded? Return exact labeled integers: References, Visits, Returning, Net cents. Explain whether these are unique people and the identity coverage."});
   const turnTools=turn.tools??[];
   expect(turn.endReason).toBe("complete");expect(turnTools).toContain("query_data");
   for(const [label,value] of [["References",expected.references],["Visits",expected.visits],["Returning",expected.returning],["Net cents",expected.net]] as const){
    const match=turn.text.match(new RegExp(label+"[\\s*]*[:=][\\s*]*([0-9,]+)","i"));
    expect(match?.[1]&&Number(match[1].replace(/,/g,""))).toBe(value);
   }
   expect(turn.text).toMatch(/observed|linked|reference/i);
   const foreignOrder=randomUUID(),foreignPayload=JSON.stringify({guid:foreignOrder,checks:[{guid:randomUUID(),amount:5,customer:{guid:randomUUID()}}]});
   await admin.query("insert into public.toast_raw_records(business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key) values($1,$2,'order',$3,$4,$5,$6)",[foreignBusinessId,foreignRestaurant,date(-3),foreignPayload,createHash("sha256").update(foreignPayload).digest("hex"),"live:"+foreignOrder]);
   expect((await admin.query("select count(*)::int n from public.customer_visits_for($1,$2,$3)",[foreignBusinessId,date(-14),date(-1)])).rows[0].n).toBe(1);
   const scoped=await ownerDb.rpc("customer_visits_for",{p_business_id:foreignBusinessId,p_from:date(-14),p_to:date(-1)});
   expect(scoped.error).toBeNull();expect(scoped.data).toEqual([]);
   const refresh=async()=>{await refreshBusinessAnomalies(db,businessId,today,"UTC",now).catch(error=>{
    if(!(error instanceof Error)||error.message!=="business_anomaly_refresh_incomplete")throw error;
   });};
   await refresh();
   const findAlert=async()=>(await admin.query("select id,status,payload from public.alerts where business_id=$1 and kind='business_anomaly' and payload->>'dedupeKey'='customer_trend:returning_visit_share'",[businessId])).rows;
   const found=await findAlert();expect(found).toHaveLength(1);expect(found[0].status).toBe("new");
   expect(Number(found[0].payload.current)).toBe(1);expect(Number(found[0].payload.previous)).toBe(0);
   const sourceId=found[0].id as string;
   await refresh();expect((await findAlert()).map(x=>x.id)).toEqual([sourceId]);
   const hash=createHash("sha256").update(JSON.stringify(found[0].payload)).digest("hex");
   const args={p_business_id:businessId,p_owner_user_id:ownerUserId,p_thread_id:threadId,p_source_type:"alert",p_source_id:sourceId,p_revision_hash:hash,p_stable_key:hash,p_priority:400,p_now:now.toISOString()};
   const queued=await db.rpc("supervisor_enqueue_investigation",args);
   expect(queued.error).toBeNull();expect(queued.data).toBe(true);
   expect((await db.rpc("supervisor_enqueue_investigation",args)).data).toBe(false);
   expect(await processDueInvestigations(db,now,2,provider,capture)).toMatchObject({processed:2,collected:1,investigated:1,failed:0});
   const episode=(await admin.query("select episode_id,phase from public.supervisor_investigations where business_id=$1 and source_id=$2",[businessId,sourceId])).rows[0];
   expect(episode.phase).toBe("awaiting_owner");
   const messages=(await admin.query("select id from public.ai_messages where business_id=$1 and owner_user_id=$2 and thread_id=$3 and role='supervisor' order by created_at desc",[businessId,ownerUserId,threadId])).rows;
   expect(messages.length).toBeGreaterThan(0);
   const replyId=messages[0].id;
   const workerTools=[...new Set(proofs.flatMap(p=>p.toolNames))];
   expect(workerTools).toContain("get_investigation_source");expect(workerTools).toContain("query_data");
   expect(workerTools.some(t=>["get_labor","get_schedule","get_week_schedule","get_inventory","get_usage_variance","get_menu_items","get_price_monitor_status","get_ingredient_costs","get_expenses","get_bills"].includes(t))).toBe(true);
   expect(proofs.every(p=>!p.externalEffectClaim&&p.unverifiedCount===0)).toBe(true);
   // Loss of source coverage must not clear the open incident.
   await admin.query("update public.toast_day_status set coverage_complete=false where business_id=$1 and business_date=$2",[businessId,date(-3)]);
   await refresh();expect((await findAlert())[0].status).toBe("new");
   await admin.query("update public.toast_day_status set coverage_complete=true where business_id=$1 and business_date=$2",[businessId,date(-3)]);
   // Correct mistaken identity attribution, not generated alert status.
   // The recalculated current week now contains first-observed references.
   for(const r of current){
    const newGuest=randomUUID();
    await admin.query("update public.toast_raw_records set payload=jsonb_set(payload,'{checks,0,customer,guid}',to_jsonb($3::text)),payload_sha256=$4 where business_id=$1 and capture_key=$2",
     [businessId,"trend:"+r.order,newGuest,createHash("sha256").update(r.order+newGuest).digest("hex")]);
   }
   await refresh();const resolved=await findAlert();
   expect(resolved).toHaveLength(1);expect(resolved[0].id).toBe(sourceId);expect(resolved[0].status).toBe("resolved");
   expect(Number(resolved[0].payload.current)).toBe(0);
   const after=(await admin.query("select episode_id from public.supervisor_investigations where business_id=$1 and source_id=$2",[businessId,sourceId])).rows;
   expect(after).toEqual([{episode_id:episode.episode_id}]);
   expect((await admin.query("select count(*)::int n from public.supervisor_effect_attempts where business_id=$1",[businessId])).rows[0].n).toBe(0);
   const toolNames=[...new Set([...turnTools,...workerTools])];
   expect(providerCompletions).toBe(ledger.calls);expect(ledger.calls).toBeGreaterThanOrEqual(3);
   const proof={schema_version:1,task:scenario,head_sha:head,status:"passed",observed_model:"gpt-6-luna",provider:"openai_responses",provider_calls:ledger.calls,provider_completions:providerCompletions,tool_names:toolNames,actual_source_detector:true,authenticated_scope:true,independent_oracle:true,source_corrected:true,no_unapproved_effect:true,feature_proven:false,integrated_proven:false,released_proven:false};
   mkdirSync("test-results/acceptance",{recursive:true});
   writeFileSync("test-results/acceptance/"+scenario+"-proof.json",JSON.stringify(proof)+"\n",{mode:0o600,flag:"wx"});
   writeFileSync("test-results/acceptance/"+scenario+"-scope.json",JSON.stringify({...scope,foreignBusinessId,sourceId,episodeId:episode.episode_id,replyId,queryOwnerId,expectedProviderCalls:ledger.calls})+"\n",{mode:0o600,flag:"wx"});
   return;
  }
  // Real operational retained records; no synthetic alert or simulated provider calls.
  for(const [cafe,rest] of [[businessId,restaurant],[foreignBusinessId,foreignRestaurant]]){
   for(const offset of [-10,-3]){
    const order=randomUUID(),check=randomUUID();
    const payload={guid:order,checks:[{guid:check,amount:7,tabName:"Guest",...(cafe===foreignBusinessId?{customer:{guid:randomUUID()}}:{}),selections:[{guid:randomUUID(),displayName:"Latte",quantity:1,price:7}]}]};
    await admin.query("insert into public.toast_raw_records(business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key) values($1,$2,'order',$3,$4,$5,$6)",[cafe,rest,date(offset),JSON.stringify(payload),createHash("sha256").update(JSON.stringify(payload)).digest("hex"),"live:"+order]);
   }
  }
  // Verify the actual SQL query and scoped read using an authenticated owner.
  await admin.query("begin");
  try{
   await admin.query("set local role authenticated");
   await admin.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[ownerUserId,JSON.stringify({sub:ownerUserId,role:"authenticated"})]);
   const query="select count(*)::int n from public.toast_records_for($1,$2,$3) where record_type='check' and counts_in_sales";
   expect((await admin.query(query,[businessId,date(-14),date(-1)])).rows[0].n).toBe(2);
   expect((await admin.query(query,[foreignBusinessId,date(-14),date(-1)])).rows[0].n).toBe(0);
   expect((await admin.query("select count(*)::int n from public.customer_visits_for($1,$2,$3)",[foreignBusinessId,date(-14),date(-1)])).rows[0].n).toBe(0);
  }finally{await admin.query("rollback");}
  expect((await admin.query("select count(*)::int n from public.customer_visits_for($1,$2,$3)",[foreignBusinessId,date(-14),date(-1)])).rows[0].n).toBe(2);
  await refreshBusinessAnomalies(db,businessId,today,"UTC",now).catch(error=>{
   if(!(error instanceof Error)||error.message!=="business_anomaly_refresh_incomplete")throw error;
  });
  const alert=(await admin.query("select id,payload from public.alerts where business_id=$1 and kind='business_anomaly' and status='new' and payload->>'dedupeKey'='data_gap:customer_identity_coverage'",[businessId])).rows;
  expect(alert).toHaveLength(1);
  const sourceId=alert[0].id as string;
  const hash=createHash("sha256").update(JSON.stringify(alert[0].payload)).digest("hex");
  const queued=await db.rpc("supervisor_enqueue_investigation",{p_business_id:businessId,p_owner_user_id:ownerUserId,p_thread_id:threadId,p_source_type:"alert",p_source_id:sourceId,p_revision_hash:hash,p_stable_key:hash,p_priority:400,p_now:now.toISOString()});
  expect(queued.error).toBeNull();expect(queued.data).toBe(true);
  expect(await processDueInvestigations(db,now,2,provider,capture)).toMatchObject({processed:2,collected:1,investigated:1,failed:0});
  const row=(await admin.query("select episode_id,phase from public.supervisor_investigations where business_id=$1 and source_id=$2",[businessId,sourceId])).rows[0];
  expect(row.phase).toBe("awaiting_owner");
  const messages=(await admin.query("select id from public.ai_messages where business_id=$1 and owner_user_id=$2 and thread_id=$3 and role='supervisor' order by created_at desc",[businessId,ownerUserId,threadId])).rows;
  expect(messages.length).toBeGreaterThan(0);
  const replyId=messages[0].id;
  expect((await admin.query("select status from public.alerts where id=$1",[sourceId])).rows[0].status).toBe("new");
  expect((await admin.query("select count(*)::int n from public.supervisor_effect_attempts where business_id=$1",[businessId])).rows[0].n).toBe(0);
  const toolNames=[...new Set(proofs.flatMap(p=>p.toolNames))];
  expect(toolNames).toContain("get_investigation_source");expect(toolNames).toContain("query_data");
  expect(proofs.every(p=>!p.externalEffectClaim&&p.unverifiedCount===0)).toBe(true);
  expect(providerCompletions).toBe(ledger.calls);expect(ledger.calls).toBeGreaterThanOrEqual(2);
  const proof={schema_version:1,task:scenario,head_sha:head,status:"passed",observed_model:"gpt-6-luna",provider:"openai_responses",provider_calls:ledger.calls,provider_completions:providerCompletions,tool_names:toolNames,actual_source_detector:true,authenticated_scope:true,no_unapproved_effect:true,feature_proven:false,integrated_proven:false,released_proven:false};
  mkdirSync("test-results/acceptance",{recursive:true});
  writeFileSync("test-results/acceptance/"+scenario+"-proof.json",JSON.stringify(proof)+"\n",{mode:0o600,flag:"wx"});
  writeFileSync("test-results/acceptance/"+scenario+"-scope.json",JSON.stringify({...scope,foreignBusinessId,sourceId,episodeId:row.episode_id,replyId,expectedProviderCalls:ledger.calls})+"\n",{mode:0o600,flag:"wx"});
 }finally{await admin.end();}
},240000);
