/** Real registered model + disposable migrated DB. Enabled ONLY by the
 * existing shared owner-gated broker. The organizer cancellation is a
 * deterministic source fixture, not a purchased public-web search. */
import {randomUUID} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {Client} from "pg";
import {createClient} from "@supabase/supabase-js";
import {expect,it,vi} from "vitest";
import type {AgentProvider} from "@/lib/ai/agent/loop.server";
vi.mock("server-only",()=>({}));
const calls=vi.hoisted(()=>({started:0,completed:0}));
// Observe/cap the real provider transport only. The registered tools, actual
// operating schedule, canonical readers, approvals, monitor and persistence
// are NOT replaced or mocked.
vi.mock("@/lib/ai/agent/loop.server",async importOriginal=>{
 const actual=await importOriginal<typeof import("@/lib/ai/agent/loop.server")>();
 const provider:AgentProvider=async function*(params,signal){
   if(params.model!=="gpt-6-luna")throw Error("real_luna_required");
   calls.started++;
   for await(const event of actual.openAIProvider({...params,
     max_output_tokens:Math.min(Number(params.max_output_tokens),1200)},signal)){
     if(event.type==="response.completed"){
       expect((event.response as {model?:unknown}).model).toBe("gpt-6-luna");
       calls.completed++;
     }
     yield event;
   }
 };
 return {...actual,runAgentTurn:(args:Parameters<typeof actual.runAgentTurn>[0])=>
   actual.runAgentTurn({...args,provider})};
});
const run=process.env.AICAFE_SHARED_LUNA==="1"&&
 process.env.AICAFE_SHARED_LUNA_SCENARIO==="8b-multiday-lifecycle"?it:it.skip;
run("real Luna reads exact multi-day event, prepares proactively, preserves decisions and reports verified cancellation",async()=>{
 const head=process.env.AICAFE_SHARED_LUNA_HEAD??"";
 if(!/^[a-f0-9]{40}$/.test(head)||process.env.AI_CAFE_LIVE_ACCEPTANCE!=="OWNER_APPROVED_LOCAL_ONLY"||
    process.env.SUPERVISOR_OPENAI_MODEL!=="gpt-6-luna"||!process.env.OPENAI_API_KEY)
   throw Error("owner_gated_exact_head_required");
 const endpoint=(raw:string|undefined,protocol:string,port:string)=>{
   if(!raw)throw Error("missing_disposable_endpoint");
   const u=new URL(raw);
   if(!["localhost","127.0.0.1"].includes(u.hostname)||u.protocol!==protocol||u.port!==port)
     throw Error("non_disposable_endpoint");
   return raw;
 };
 const sql=new Client({connectionString:endpoint(process.env.ACCEPTANCE_DATABASE_URL,"postgresql:","54322")});
 const db=createClient(endpoint(process.env.NEXT_PUBLIC_SUPABASE_URL,"http:","54321"),
   process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
 const {cafeToday}=await import("@/lib/metrics/core/clock");
 const {addDays}=await import("./holidays");
 const {upsertCityEventFact,linkCityEventToCafeEvent}=await import("./cityEventPersistence.server");
 const {readSavedEventTimeline,readExactCafeEvent}=await import("@/lib/data/cafeEvents.server");
 const {draftDay,eventAssessmentSourceHash,reportSavedEventDays}=await import("./eventsLookahead.server");
 const {eventPlanFacts}=await import("@/lib/ai/supervisor/loop/eventReadiness.server");
 const {effectHash}=await import("@/lib/ai/supervisor/loop/engine");
 const {verifyUpcomingEventChanges}=await import("./eventVerification.server");
 const {runAgentTurn}=await import("@/lib/ai/agent/loop.server");
 const {changeExternalAccess}=await import("@/lib/connectors/access.server");
 const businessId=randomUUID(),foreignBusinessId=randomUUID(),ownerId=randomUUID(),foreignOwnerId=randomUUID(),
   cafeEventId=randomUUID(),threadId=randomUUID();
 const timezone="America/Los_Angeles",today=cafeToday(timezone),startDate=addDays(today,1),endDate=addDays(today,2);
 const city="Luna Acceptance "+businessId.slice(0,8);
 const cityScope={city,region:"CA",countryCode:"US"};
 const name="Two-day Civic Convention",sourceUrl="https://events.example.invalid/convention/"+cafeEventId;
 const scope={businessId,ownerUserId:ownerId};
 await sql.connect();
 try{
   await sql.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values "+
     "($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now()),"+
     "($3,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$4,'',now(),now())",
     [ownerId,ownerId+"@example.invalid",foreignOwnerId,foreignOwnerId+"@example.invalid"]);
   await sql.query("insert into public.businesses(id,name,timezone,currency,is_demo) values($1,'8B synthetic cafe',$3,'USD',false),($2,'8B foreign cafe',$3,'USD',false)",[businessId,foreignBusinessId,timezone]);
   await sql.query("insert into public.cafe_access(business_id,mode) values($1,'grandfathered'),($2,'grandfathered') on conflict(business_id) do update set mode='grandfathered',access_end=null",[businessId,foreignBusinessId]);
   await sql.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",[businessId,ownerId,foreignBusinessId,foreignOwnerId]);
   const hours=Object.fromEntries(["mon","tue","wed","thu","fri","sat","sun"].map(k=>[k,[["07:00","18:00"]]]));
   await sql.query("insert into public.locations(business_id,name,timezone,address_line1,city,region,country_code,open_hours) values($1,'Main cafe',$2,'21 Civic St',$3,'CA','US',$4)",[businessId,timezone,city,JSON.stringify(hours)]);
   await sql.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",[threadId,businessId,ownerId,randomUUID()]);
   const cityEventId=(await upsertCityEventFact(db,{...cityScope,name,kind:"conference",startDate,endDate,
     sourceUrl,venue:"Civic Hall",venueAddress:"20 Civic St",checkedAt:new Date().toISOString()})).cityEventId;
   const verified=await db.from("city_events").update({end_date:endDate,duration_verified_at:new Date().toISOString(),
     duration_source_url:sourceUrl,start_time:"09:00",end_time:"16:00",time_source_url:sourceUrl})
     .eq("id",cityEventId);
   if(verified.error)throw verified.error;
   const saved=await db.from("cafe_events").insert({id:cafeEventId,business_id:businessId,name,kind:"conference",
     start_date:startDate,end_date:endDate,venue:"Civic Hall",venue_address:"20 Civic St",
     source_url:sourceUrl,status:"found"});
   if(saved.error)throw saved.error;
   await linkCityEventToCafeEvent(db,{businessId,cafeEventId,cityEventId});
   // Prevent external web research on synthetic fixtures. The exact cited
   // source and saved local facts are the authority for this test.
   const denied=await changeExternalAccess(scope,"public_web","public",false,0);
   const timeline=await readSavedEventTimeline(db,scope,startDate,endDate);
   const event=timeline.events.find(e=>e.id===cafeEventId)!;
   expect(event).toMatchObject({id:cafeEventId,startDate,endDate,datePrecision:"verified_range"});
   expect((await readExactCafeEvent(db,businessId,cafeEventId,endDate,endDate))?.id).toBe(cafeEventId);
   expect(await readExactCafeEvent(db,foreignBusinessId,cafeEventId,endDate,endDate)).toBeNull();
   const chat=await runAgentTurn({businessId,requestId:randomUUID(),
     ownerText:"What is the exact saved event on "+endDate+" [id:"+cafeEventId+"]? Read get_events with that ID and date, and explain the verified duration without assuming sales.",
     toolNames:["get_events"],context:{asOf:today,timezone,locale:"en",threadId,
       savedEvents:(from,to,options)=>readSavedEventTimeline(db,scope,from,to,options),
       tools:{getProfitability:async()=>{throw Error("unavailable")},getSalesTrend:async()=>{throw Error("unavailable")},getMenuCatalog:async()=>{throw Error("unavailable")}}}});
   expect(chat.usage.model).toBe("gpt-6-luna");
   expect(chat.results.some(r=>r.source==="cafe_events"&&JSON.stringify(r).includes(cafeEventId))).toBe(true);
   expect(await draftDay(db,{id:businessId,timezone,is_demo:false},ownerId,"en",today,
     {date:startDate,events:[event],hash:effectHash(eventPlanFacts([event]))},[],timeline,eventAssessmentSourceHash(timeline))).toBe(true);
   const plans=(await readSavedEventTimeline(db,scope,startDate,endDate)).plans;
   expect(plans).toHaveLength(1);
   expect(plans[0]).toMatchObject({status:"draft",eventIds:[cafeEventId]});
   const proposalId=plans[0].proposalId;
   const evidenceBefore=await sql.query("select count(*)::int as count from public.supervisor_approvals where proposal_id=$1",[proposalId]);
   expect(evidenceBefore.rows[0].count).toBe(0);
   // The exact source-check port returns an explicit organizer correction;
   // no real public web transport is performed by this synthetic source.
   await changeExternalAccess(scope,"public_web","public",true,denied.revision);
   expect(await verifyUpcomingEventChanges(db,businessId,ownerId,timezone,today,
     await readSavedEventTimeline(db,scope,startDate,endDate),new Date(),async()=>({
       evidence:{verdict:"cancelled",sourceUrl,statement:"Organizer cancelled both convention dates.",newDate:null,newVenue:null},citedUrls:[sourceUrl]
     }))).toBe(1);
   await changeExternalAccess(scope,"public_web","public",false,denied.revision+1);
   expect((await readExactCafeEvent(db,businessId,cafeEventId,startDate,endDate))?.status).toBe("cancelled");
   // Advance the scheduled logical closed-day date, not system time or the
   // source rows. Inactive days cannot create fictional future sales.
   const closed=await reportSavedEventDays(db,businessId,ownerId,addDays(endDate,1));
   expect(closed.failed).toBe(0);
   const report=(await sql.query("select status,report from public.supervisor_reports where business_id=$1 and proposal_id=$2",[businessId,proposalId])).rows[0];
   expect(report).toMatchObject({status:"insufficient_evidence",report:{observedDays:0,salesSummary:{observedSalesCents:null}}});
   expect((await sql.query("select count(*)::int as count from public.supervisor_approvals where proposal_id=$1",[proposalId])).rows[0].count).toBe(0);
   expect(calls.started).toBe(calls.completed);expect(calls.completed).toBeGreaterThan(1);
   mkdirSync("test-results/acceptance",{recursive:true});
   writeFileSync("test-results/acceptance/8b-multiday-lifecycle-proof.json",JSON.stringify({head_sha:head,status:"passed",observed_model:"gpt-6-luna",syntheticOrganizerCorrection:true,realRegisteredToolAndDb:true}));
   writeFileSync("test-results/acceptance/8b-multiday-lifecycle-scope.json",JSON.stringify({businessId,foreignBusinessId,ownerId,cafeEventId,cityEventId,proposalId,startDate,endDate,expectedProviderCalls:calls.completed}));
 }finally{await sql.end();}
},180000);
