import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {assessCoverage,requiredFamilies,proactiveRequirements,auditProactiveInventory,verifyRoutineAndFile,verifyScheduledOccurrence,verifyOperatingWorld,verifyProcurementOutcome,verifyRevocationOutcome,verifyMonitorOutcome,verifySupplierReminderOutcome,verifySourceAlertLifecycle} from "./task17c-oracle.mjs";
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

test("operating-world proof rejects restarted identity, missing follow-up, unauthorized effect and fabricated usage",()=>{
 const staff={businessId:"staff",ownerUserId:"s-owner",taskId:"staff-source",shiftId:"shift",employeeId:"absent"};
 const finance={businessId:"finance",ownerUserId:"f-owner",taskId:"finance-source",firstUploadId:"upload1"};
 const staffRow={business_id:"staff",source_id:"staff-source",episode_id:"staff-episode",phase:"awaiting_owner",lease_token:null,evidence:{modelTools:["get_investigation_source","get_staff_messages","get_schedule"]}};
 const financeRow={business_id:"finance",source_id:"finance-source",episode_id:"finance-episode",phase:"awaiting_owner",lease_token:null,evidence:{modelTools:["get_investigation_source","get_cashflow_evidence","get_bills"]}};
 const usage=["staff","staff","finance","finance"].map(business_id=>({business_id,model:"gpt-6-luna",status:"completed",input_tokens:100}));
 const good={world:{staff,finance,initialCash:200,laterCash:500},evidence:{
  queued:[staffRow,financeRow],recovered:[staffRow,financeRow],followed:[staffRow,financeRow],
  originalPid:123,recoveryPid:124,interruptedEpisode:"staff-episode",
  staffNotices:[{id:"staff-notice"}],financeBefore:[{id:"f1"}],financeNew:[{id:"f2"}],
  ownerRows:[],effects:[],proposals:[],shifts:[{id:"shift",employee_id:"absent",status:"sent"}],
  sources:[{id:"upload1",business_id:"finance",financial_closing_cents:200},{id:"upload2",business_id:"finance",financial_closing_cents:500}],secondUploadId:"upload2",
  usage:[...usage,{business_id:"staff",model:"gpt-6-luna",status:"attempted",input_tokens:null}]
 }};
 assert.equal(verifyOperatingWorld(good).providerCalls,4);
 for(const mutate of [x=>x.recovered=[{...x.recovered[0],episode_id:"new"},x.recovered[1]],x=>x.financeNew=[],x=>x.effects=[{}],x=>x.usage[0].model="fallback",x=>x.sources[1].financial_closing_cents=600,x=>x.ownerRows=[{}],x=>x.staffNotices.push({id:"duplicate"}),x=>x.recoveryPid=x.originalPid]){
  const copy=structuredClone(good);mutate(copy.evidence);assert.throws(()=>verifyOperatingWorld(copy));
 }
});

test("procurement outcome requires exactly one approved effect across lost ACK and replay",()=>{
 const expected={supplier:"vendor",quoteId:"quote",packs:4,price:600,currency:"TEST",ownerUserId:"owner"};
 const proposal={id:"p",status:"draft",capability_id:"maya.supplier_purchase_order.v1",effect_hash:"hash",canonical_effect_payload:{supplierName:"vendor",currency:"TEST",subtotalCents:2400,lines:[{quoteId:"quote",packs:4}]}};
 const receipt={attempt_key:"attempt",effect_hash:"hash",authorization_kind:"click",state:"verified",receipt_ref:"purchase_orders:po"};
 const order={id:"po",proposal_id:"p",status:"approved_for_ordering",subtotal_cents:2400,currency_code:"TEST",effect_hash:"hash"};
 const counts={stock:0,expenses:0,remote:0};
 const fixture={expected,proposal,preOrders:[],preAttempts:[],foreignOrders:[],foreignAttempts:[],foreignStatus:403,dropped:true,serverStatus:200,committed:[order],committedAttempts:[receipt],after:[{...order}],afterAttempts:[{...receipt}],approvals:[{owner_user_id:"owner",effect_hash:"hash",authorization_kind:"click"}],finalProposal:[{id:"p",status:"committed",effect_hash:"hash"}],replayStatus:409,before:counts,afterCounts:{...counts}};
 assert.equal(verifyProcurementOutcome(fixture),"po");
 for(const mutate of [x=>x.preOrders.push(order),x=>x.foreignAttempts.push(receipt),x=>x.proposal.canonical_effect_payload.subtotalCents++,x=>x.committedAttempts[0].state="uncertain",x=>x.committedAttempts[0].receipt_ref="purchase_orders:other",x=>x.afterAttempts.push(receipt),x=>x.after.push(order),x=>x.approvals[0].owner_user_id="foreign",x=>x.dropped=false,x=>x.afterCounts.stock++]){
  const bad=structuredClone(fixture);mutate(bad);assert.throws(()=>verifyProcurementOutcome(bad));
 }
});

test("revoked file and old model context are unavailable without any mutation",()=>{
 const good={canary:"private-canary",qty:47,good:[{text:"Oat milk 47 private-canary"}],after:[{text:"The file is no longer accessible."}],blocked:"supervisor_file_access_revoked",blockedUse:[],foreignStatus:503,foreignError:"access_change_unverified",prematureAccess:[],access:[{allowed:false}],proposals:[],before:{stock:0,expenses:0,remote:0},afterCounts:{stock:0,expenses:0,remote:0}};
 assert.doesNotThrow(()=>verifyRevocationOutcome(good));
 for(const mutate of [x=>x.good=[{text:"Wrong item 47 private-canary"}],x=>x.good=[{text:"Oat milk 147 private-canary"}],x=>x.after=[{text:"private-canary"}],x=>x.blocked="http_500",x=>x.blockedUse=[{}],x=>x.foreignStatus=200,x=>x.foreignError="unknown",x=>x.prematureAccess=[{}],x=>x.access[0].allowed=true,x=>x.proposals=[{}],x=>x.afterCounts.remote=1]){
  const bad=structuredClone(good);mutate(bad);assert.throws(()=>verifyRevocationOutcome(bad));
 }
});

test("source alert lifecycle rejects healthy-cafe false positive and fabricated closure",()=>{
 const alert={id:"a",business_id:"cafe",status:"new"};
 const ep={episode_id:"episode",phase:"awaiting_owner",evidence:{modelTools:["get_investigation_source","get_expenses","get_bills"]}};
 const good={businessId:"cafe",alertId:"a",oldExpenseId:"old",newExpenseId:"new",amount:12000,opened:[alert],repeated:[{...alert}],pending:[ep],closed:[{...alert,status:"resolved"}],finished:[{...ep,phase:"resolved"}],beforeNotices:[{id:"n1"}],afterNotices:[{id:"n2"}],ownerRows:[],effects:[],expenses:[{id:"old",amount_cents:12000},{id:"new",amount_cents:12000}],usage:[{model:"gpt-6-luna",status:"completed",input_tokens:100},{model:"gpt-6-luna",status:"completed",input_tokens:200}]};
 assert.equal(verifyMonitorOutcome(good).episodeId,"episode");
 for(const mutate of [x=>x.opened.push({...alert,business_id:"healthy"}),x=>x.repeated.push(alert),x=>x.pending[0].evidence.modelTools=["get_investigation_source"],x=>x.closed[0].status="new",x=>x.finished[0].episode_id="replacement",x=>x.afterNotices=[],x=>x.ownerRows=[{}],x=>x.effects=[{}],x=>x.expenses[1].amount_cents++,x=>x.usage[0].model="fallback"]){
  const bad=structuredClone(good);mutate(bad);assert.throws(()=>verifyMonitorOutcome(bad));
 }
});

test("proactive register covers actual signal, task and scheduled job inventories without treating a question as proactivity",()=>{
 const root=new URL("../../../",import.meta.url);
 const read=path=>readFileSync(new URL(path,root),"utf8");
 const quoted=s=>[...s.matchAll(/"([^"]+)"/g)].map(m=>m[1]);
 const signals=quoted(read("lib/operating/types.ts").match(/CAFE_SIGNAL_TYPES\s*=\s*\[([\s\S]*?)\]\s*as const/)[1]);
 const taskKinds=quoted(read("lib/operating/tasks.ts").match(/export type OperatingTaskKind\s*=\s*([^;]+);/)[1]);
 const cronPaths=JSON.parse(read("vercel.json")).crons.map(c=>c.path);
 const manifestIds=readdirSync(new URL(".github/luna/scenarios/",root)).filter(x=>x.endsWith(".json")).map(x=>x.slice(0,-5));
 const routePaths=readdirSync(new URL("app/api/cron/",root),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>"/api/cron/"+x.name);
 const input={signals,taskKinds,cronPaths,routePaths,manifestIds};
 const audit=auditProactiveInventory(input);
 assert.ok(signals.length>=14); // all additions must also appear in the obligation list
 assert.ok(taskKinds.length>=16&&cronPaths.length>=12);
 assert.deepEqual(audit.missingSignals,[]);
 assert.deepEqual(audit.missingTaskKinds,[]);
 assert.deepEqual(audit.missingCrons,[]);
 assert.deepEqual(audit.retiredCrons,[]);
 assert.deepEqual(audit.missingRoutes,[]);
 assert.deepEqual(audit.retiredRoutes,[]);
 assert.ok(audit.unscheduledWorkers.includes("supervisor-run-worker"));
 assert.deepEqual(audit.missingCandidates,[]);
 assert.equal(audit.complete,false);
 assert.ok(audit.unregistered.some(x=>x.family==="sales_drop_live"&&x.state==="trigger_gap"));
 assert.ok(requiredFamilies.includes("goal_checkin_due_answer_missed"));
 assert.ok(proactiveRequirements.find(x=>x.family==="event_discovery_no_action_or_plan").candidates.length===0);
 const drift=auditProactiveInventory({...input,signals:[...signals,"NEW_SOURCE_SIGNAL"],taskKinds:[...taskKinds,"new_task"],cronPaths:[...cronPaths,"/api/cron/new-monitor"],routePaths:[...routePaths,"/api/cron/new-worker"],manifestIds:[]});
 assert.deepEqual(drift.missingSignals,["NEW_SOURCE_SIGNAL"]);
 assert.deepEqual(drift.missingTaskKinds,["new_task"]);
 assert.deepEqual(drift.missingCrons,["new-monitor"]);
 assert.deepEqual(drift.missingRoutes,["new-worker"]);
 assert.ok(drift.missingCandidates.length>0);
});

test("overdue draft and unsent order notices need exact original thread, no duplicate or side effect",()=>{
 const draft={id:"draft-notice",thread_id:"t",status:"needs_owner"},sent={id:"dispatch-notice",thread_id:"t",status:"needs_owner"};
 const dm={id:"draft-message",thread_id:"t",structured_content:[{text:"Supplier purchase-order draft needs your approval"}]};
 const sm={id:"dispatch-message",thread_id:"t",structured_content:[{text:"Approved order unresolved: was the supplier contacted?"}]};
 const fixture={threadId:"t",earlyDraft:[],draftNotice:[draft],draftMessage:[dm],repeatedDraft:[{...draft}],repeatedDraftMessage:[{...dm}],handledDraft:[{...draft,status:"handled"}],earlyDispatch:[],dispatchNotice:[sent],dispatchMessage:[sm],repeatedDispatch:[{...sent}],repeatedDispatchMessage:[{...sm}],ownerBefore:[{id:"owner"}],ownerAfter:[{id:"owner"}],delivery:[],ordersBefore:[{id:"po"}],ordersAfter:[{id:"po"}],attemptsBefore:[{id:"attempt"}],attemptsAfter:[{id:"attempt"}],countsBefore:{stock:1,expenses:2,remote:0},countsAfter:{stock:1,expenses:2,remote:0}};
 assert.equal(verifySupplierReminderOutcome(fixture).dispatchNoticeId,"dispatch-notice");
 for(const mutate of [x=>x.earlyDraft.push({}),x=>x.draftNotice[0].thread_id="wrong",x=>x.handledDraft[0].status="needs_owner",x=>x.dispatchMessage[0].structured_content=[{text:"I sent the order"}],x=>x.repeatedDispatch.push(sent),x=>x.ownerAfter.push({id:"prompt"}),x=>x.delivery.push({}),x=>x.attemptsAfter.push({}),x=>x.countsAfter.remote++]){
  const bad=structuredClone(fixture);mutate(bad);assert.throws(()=>verifySupplierReminderOutcome(bad));
 }
});

test("void and meal break source detectors must distinguish complete evidence and actual attendance",()=>{
 const a={id:"meal",kind:"meal_break",status:"new",impact_cents:1800,payload:{timecardId:"actual"}};
 const b={id:"void",kind:"voids",status:"new",impact_cents:12000,payload:{voidsThisMonthCents:12000,avgVoidsPrevious3MonthsCents:0}};
 const fixture={negative:[],opened:[a,b],repeated:[structuredClone(a),structuredClone(b)],closed:[{...a,status:"resolved"},{...b,status:"resolved"}],repeatedClosed:[{...a,status:"resolved"},{...b,status:"resolved"}],actualTimecard:"actual",plannedTimecard:"planned",wage:1800,voidCents:12000,effects:[],ownerRows:[]};
 assert.equal(verifySourceAlertLifecycle(fixture).voidAlertId,"void");
 for(const mutate of [x=>x.negative.push(a),x=>x.opened[0].payload.timecardId="planned",x=>x.opened[1].impact_cents++,x=>x.repeated.push(b),x=>x.closed[0].status="new",x=>x.repeatedClosed.pop(),x=>x.effects.push({}),x=>x.ownerRows.push({})]){
  const bad=structuredClone(fixture);mutate(bad);assert.throws(()=>verifySourceAlertLifecycle(bad));
 }
});
