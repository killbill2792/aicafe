#!/usr/bin/env node
/** Deferred owner-authorized U3 real Luna acceptance: authenticated Supervisor,
 * source-to-tool evidence and independent SQL truth, without approving effects.
 * Never run in regular PR CI or without the shared-Luna owner authorization. */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,readFileSync,statSync,writeFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {completedSqlReceiptCount,hasCompletedSqlSources,readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";
import {matchedMoney} from "./u2-model-execution.mjs";

const fail=(reason)=>{throw Error("u3_canonical_research_live:"+reason);};
const query=async(db,sql,args=[])=> (await db.query(sql,args)).rows;
export function matchedCount(text,n){
 if(!Number.isSafeInteger(n)||n<0||typeof text!=="string")return false;
 return new RegExp("(^|[^0-9])"+String(n)+"([^0-9]|$)").test(text.replace(/,/g,""));
}
export function assertU3ObservedEvidence({model,tools,text,orders,lines,cents,proposals,sqlReceipts}){
 requireObservedProductionModel(model,"gpt-6-luna");
 if(!Array.isArray(tools)||!tools.includes("query_data"))fail("registered_research_tool_not_used");
 if(!Number.isSafeInteger(sqlReceipts)||sqlReceipts<1)fail("committed_sql_research_not_observed");
 if(!matchedMoney(text,cents)||!matchedCount(text,orders)||!matchedCount(text,lines))
  fail("independent_source_result_mismatch");
 if(proposals!==0)fail("unapproved_effect_created");
}
export function resolveU3ProofPaths(args,env){
 if(env.AICAFE_SHARED_LUNA_CANDIDATE!=="1"||env.AICAFE_SHARED_LUNA_PROOF_DIR!=="/proof"||
   args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")
  fail("private_output_and_scope_required");
 const out=resolve(args[1]),scopeOut=resolve(args[3]);
 if(out!=="/proof/u3-canonical-research-proof.json"||scopeOut!=="/proof/u3-canonical-research-scope.json")
  fail("fresh_local_evidence_path_required");
 for(const path of [out,scopeOut]){
  if(realpathSync(dirname(path))!=="/proof"||existsSync(path))fail("fresh_local_evidence_path_required");
 }
 return {out,scopeOut};
}
/** The legacy broker cannot certify production-native research parity. */
export function requireNativeResearchHost(env){
 if(env.AICAFE_SHARED_LUNA_NATIVE_RESEARCH!=="1")fail("native_research_host_required");
}
export function observedProviderCalls(usage){
 const n=Number(usage?.model_call_count);
 if(!Number.isSafeInteger(n)||n<1)fail("missing_provider_call_count");
 return n;
}
/** The exact independent oracle also runs in zero-provider disposable CI. */
export async function readU3Oracle(db,businessId){
 const days=await query(db,"SELECT o.business_date::text AS day "+
  "FROM public.orders o WHERE o.business_id=$1 GROUP BY o.business_date "+
  "HAVING sum(o.net_sales_cents)>0 ORDER BY o.business_date DESC LIMIT 1",
  [businessId]);
 const date=days[0]?.day;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date??""))fail("synthetic_source_date_missing");
 const [orders]=await query(db,"SELECT count(*)::int n, "+
  "sum(net_sales_cents)::text cents FROM public.orders "+
  "WHERE business_id=$1 AND business_date=$2",[businessId,date]);
 const [lines]=await query(db,"SELECT count(*)::int n,min(o.id::text) sample_order_id "+
  "FROM public.order_lines l JOIN public.orders o ON o.id=l.order_id "+
  "WHERE o.business_id=$1 AND o.business_date=$2",[businessId,date]);
 if(!orders||!lines||orders.n<1||lines.n<1||Number(orders.cents)<=0)
  fail("independent_oracle_missing");
 if(!/^[0-9a-f-]{36}$/i.test(lines.sample_order_id??""))fail("independent_oracle_missing");
 return {date,orders,lines};
}
/** Independently generate and read unfamiliar source facts. This helper is
 * also executed by zero-provider CI against the disposable migrated database.
 * No query templates or expected values are sent to the model. */
export async function seedU3HistoryOracle(db,cafe,other){
 const connection=db.connectionParameters;
 if(!connection||!["127.0.0.1","localhost"].includes(connection.host)||
  Number(connection.port)!==54322||connection.database!=="postgres"||connection.user!=="postgres")
  fail("non_disposable_history_fixture");
 const from="2025-01-01",to="2025-03-16",prefix="u3-history-"+randomUUID()+"-";
 const employeeId=randomUUID(),timecardId=randomUUID(),openCardId=randomUUID();
 const employeeName="Harbor Sample "+randomUUID().slice(0,8).replace(/[0-9]/g,d=>String.fromCharCode(97+Number(d)));
 const [existing]=await query(db,"SELECT count(*)::int n FROM public.orders WHERE business_id=ANY($1::uuid[]) AND business_date BETWEEN $2 AND $3",
  [[cafe.businessId,other.businessId],from,to]);
 if(existing?.n!==0)fail("history_fixture_window_not_empty");
 await db.query("BEGIN");
 try{
  for(const [i,owner] of [cafe,other].entries()){
   await db.query("INSERT INTO public.orders(id,business_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents) "+
    "SELECT gen_random_uuid(),$1,$2||i::text,((date '2025-01-01'+((i-1)%75)) + CASE "+
    "WHEN i%3=0 THEN interval '23 hours 45 minutes' WHEN i%3=1 THEN interval '24 hours 45 minutes' ELSE interval '14 hours' END) AT TIME ZONE $3::text,"+
    "date '2025-01-01'+((i-1)%75),1000+i+$4,1000+i+$4 FROM generate_series(1,180) i",
    [owner.businessId,prefix,owner.timezone,i*10000]);
   await db.query("INSERT INTO public.order_lines(id,order_id,name,quantity,net_sales_cents) "+
    "SELECT gen_random_uuid(),o.id,v.name,v.quantity,CASE WHEN v.quantity=3 THEN o.net_sales_cents/3 ELSE o.net_sales_cents-o.net_sales_cents/3 END "+
    "FROM public.orders o CROSS JOIN (VALUES ($3::text,3),($4::text,1)) v(name,quantity) "+
    "WHERE o.business_id=$1 AND o.pos_order_id LIKE $2||'%'",
    [owner.businessId,prefix,i?"Foreign Orchard Tea":"Night Orchard Tea",i?"Foreign Sesame Bun":"Night Sesame Bun"]);
  }
  await db.query("INSERT INTO public.employees(id,business_id,display_name) VALUES($1,$2,$3)",[employeeId,cafe.businessId,employeeName]);
  await db.query("INSERT INTO public.timecards(id,business_id,employee_id,clock_in,clock_out,source_type,breaks) "+
   "VALUES($1,$2,$3,timestamp '2025-01-11 22:15' AT TIME ZONE $4,timestamp '2025-01-12 02:45' AT TIME ZONE $4,'connected_pos',"+
   "jsonb_build_array(jsonb_build_object('start',to_char((timestamp '2025-01-11 23:17' AT TIME ZONE $4) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),"+
   "'end',to_char((timestamp '2025-01-11 23:47' AT TIME ZONE $4) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),'paid',false))),"+
   "($5,$2,$3,timestamp '2025-03-12 21:10' AT TIME ZONE $4,NULL,'connected_pos','[]'::jsonb)",
   [timecardId,cafe.businessId,employeeId,cafe.timezone,openCardId]);
  await db.query("COMMIT");
 }catch(e){await db.query("ROLLBACK");throw e}
 const [total]=await query(db,"SELECT count(*)::int n FROM public.orders WHERE business_id=$1 AND business_date BETWEEN $2 AND $3",[cafe.businessId,from,to]);
 const args=[cafe.businessId,from,to,cafe.timezone];
 const filter="o.business_id=$1 AND o.business_date BETWEEN $2 AND $3 AND "+
  "((o.closed_at AT TIME ZONE $4::text)::time>=time '23:00' OR (o.closed_at AT TIME ZONE $4::text)::time<time '02:00')";
 const [night]=await query(db,"SELECT count(*)::int n,sum(o.net_sales_cents)::text cents,min(o.id::text) sample_id FROM public.orders o WHERE "+filter,args);
 const [top]=await query(db,"SELECT l.name,sum(l.quantity)::int units FROM public.order_lines l JOIN public.orders o ON o.id=l.order_id WHERE "+filter+" GROUP BY l.name ORDER BY units DESC,l.name LIMIT 1",args);
 const punches=await query(db,"SELECT id,to_char(clock_in AT TIME ZONE $3::text,'HH24:MI') clock_in,to_char(clock_out AT TIME ZONE $3::text,'HH24:MI') clock_out,"+
  "to_char((breaks->0->>'start')::timestamptz AT TIME ZONE $3::text,'HH24:MI') break_start,"+
  "to_char((breaks->0->>'end')::timestamptz AT TIME ZONE $3::text,'HH24:MI') break_end FROM public.timecards t WHERE business_id=$1 AND employee_id=$2 ORDER BY t.clock_in,t.id",
  [cafe.businessId,employeeId,cafe.timezone]);
 if(total?.n!==180)fail("history_fixture_order_count_"+String(total?.n));
 if(night?.n!==120||!Number.isSafeInteger(Number(night.cents))||Number(night.cents)<=0)
  fail("history_fixture_night_count_"+String(night?.n));
 if(top?.units!==360)fail("history_fixture_top_units_"+String(top?.units));
 if(punches.length!==2||punches[0].id!==timecardId||punches[1].id!==openCardId||
  punches[0].clock_in!=="22:15"||punches[0].clock_out!=="02:45"||
  punches[0].break_start!=="23:17"||punches[0].break_end!=="23:47"||
  punches[1].clock_in!=="21:10"||punches[1].clock_out!==null)
  fail("history_fixture_timecards_incomplete_"+String(punches.length));
 return {from,to,employeeId,employeeName,timecardId,openCardId,total:total.n,night,top,punches};
}
export function matchedLocalTime(text,value){
 if(typeof text!=="string"||!/^\d{2}:\d{2}$/.test(value??""))return false;
 const [h,m]=value.split(":");
 const hour=Number(h),short=hour%12||12,meridiem=hour>=12?"p":"a";
 return new RegExp("(^|[^0-9])(?:(?:"+Number(h)+":"+m+"|"+value+")(?![0-9]|\\s*[ap]\\.?m)|"+short+":"+m+"\\s*"+meridiem+"\\.?m\\.?)(?![0-9])","i").test(text);
}
export function assertU3HistoryEvidence({model,tools,text,oracle,proposals,sqlReceipts}){
 requireObservedProductionModel(model,"gpt-6-luna");
 if(!Array.isArray(tools)||!tools.includes("query_data")||!Number.isSafeInteger(sqlReceipts)||sqlReceipts<1)
  fail("historical_committed_research_missing");
 if(!matchedCount(text,oracle.total)||!matchedCount(text,oracle.night.n)||
  !matchedMoney(text,Number(oracle.night.cents))||!matchedCount(text,oracle.top.units)||
  !text.toLowerCase().includes(oracle.top.name.toLowerCase())||
  !text.toLowerCase().includes(oracle.employeeName.toLowerCase())||
  !oracle.punches.flatMap(p=>[p.clock_in,p.clock_out,p.break_start,p.break_end]).filter(Boolean).every(t=>matchedLocalTime(text,t))||
  !/\b(?:missing|unknown|incomplete|not recorded|no clock.out|open timecard)\b/i.test(text)||
  /foreign orchard tea|foreign sesame bun/i.test(text))
  fail("historical_independent_source_result_mismatch");
 if(proposals!==0)fail("unapproved_effect_created");
}
/** Two different café-specific cost structures. Independent SQL reads the
 * inserted facts; neither the test's SQL nor expected results reach Luna.
 * The variable commission is an explicitly stated hypothetical assumption,
 * not fabricated saved data. */
export async function seedU3FinancialOracle(db,cafes){
 const connection=db.connectionParameters;
 if(!connection||!["127.0.0.1","localhost"].includes(connection.host)||
  Number(connection.port)!==54322||connection.database!=="postgres"||connection.user!=="postgres")
  fail("non_disposable_financial_fixture");
 const results=[];
 await db.query("BEGIN");
 try{
  for(const [i,cafe] of cafes.entries()){
   const id=cafe.businessId;
   const [range]=await query(db,"SELECT (date_trunc('month',min(business_date))-interval '1 month')::date::text AS first,"+
    "(date_trunc('month',min(business_date))-interval '1 day')::date::text AS last FROM public.daily_rollups WHERE business_id=$1",[id]);
   if(!range?.first||!range?.last)fail("financial_fixture_date_missing");
   const [existing]=await query(db,"SELECT (SELECT count(*) FROM public.expenses WHERE business_id=$1 AND spent_on BETWEEN $2 AND $3)+"+
    "(SELECT count(*) FROM public.recurring_costs WHERE business_id=$1 AND active_from<=$3 AND (active_to IS NULL OR active_to>=$2)) AS n",
    [id,range.first,range.last]);
   if(Number(existing?.n)!==0)fail("financial_fixture_window_not_empty");
   const monthlyId=randomUUID(),annualId=randomUUID(),expenseId=randomUUID();
   const monthlyLabel=i?"Workshop equipment support":"Cold-storage retainer";
   const annualLabel=i?"Independent signage licence":"Shared delivery access";
   const oneTimeLabel=i?"Unexpected floor repair":"One-off insulation repair";
   const extraPercent=i?7:5;
   await db.query("INSERT INTO public.recurring_costs(id,business_id,category_code,label,amount_cents,frequency,is_estimate,active_from,active_to) "+
    "VALUES($1,$2,'other',$3,$4,'monthly',false,$5,$6),($7,$2,'other',$8,$9,'yearly',false,$5,$6)",
    [monthlyId,id,monthlyLabel,135000+i*51000,range.first,range.last,annualId,annualLabel,924000+i*192000]);
   await db.query("INSERT INTO public.expenses(id,business_id,spent_on,amount_cents,category_code,source,status,recurring_cost_id,custom_label,dedupe_key) "+
    "VALUES($1,$2,$3,$4,'other','manual','actual',$5,$6,$1::text),"+
    "(gen_random_uuid(),$2,$3,$7,'other','manual','actual',NULL,$8,$9),"+
    "(gen_random_uuid(),$2,$3,19000,'other','manual','estimated',$10,$11,$12)",
    [expenseId,id,range.first,45000+i*23000,monthlyId,monthlyLabel,28000+i*17000,oneTimeLabel,
     "u3-finance-"+randomUUID(),annualId,annualLabel,"u3-finance-"+randomUUID()]);
   await db.query("INSERT INTO public.daily_rollups(business_id,business_date,net_sales_cents,orders_count,drinks_count,ingredients_cents,staff_wages_cents,staff_tax_cents,card_fees_cents,card_fees_status,voids_cents,sales_data_status,voids_status) "+
    "SELECT $1,d::date,$4,100,80,$5,$6,$7,$8,'actual',0,'actual','complete' FROM generate_series($2::date,$3::date,interval '1 day') d",
    [id,range.first,range.last,100000+i*50000,20000+i*25000,30000+i*10000,2000+i*2000,3000+i*1500]);
   const [truth]=await query(db,"WITH actual AS (SELECT sum(amount_cents) AS cents FROM public.expenses WHERE business_id=$1 AND spent_on BETWEEN $2 AND $3 AND status='actual'),"+
    "budget AS (SELECT sum(CASE frequency WHEN 'yearly' THEN amount_cents::numeric/12 WHEN 'monthly' THEN amount_cents::numeric ELSE NULL END) AS cents FROM public.recurring_costs WHERE business_id=$1 AND active_from<=$3 AND (active_to IS NULL OR active_to>=$2)),"+
    "rollup AS (SELECT sum(net_sales_cents)::numeric sales,sum(ingredients_cents+card_fees_cents)::numeric variable,sum(staff_wages_cents+staff_tax_cents)::numeric labor FROM public.daily_rollups WHERE business_id=$1 AND business_date BETWEEN $2 AND $3) "+
    "SELECT actual.cents::text AS actual,budget.cents::text AS budget,(sales-variable-labor-actual.cents)::text AS known_profit,"+
    "round((budget.cents+labor)/(1-variable/sales-$4::numeric/100))::text AS break_even FROM actual,budget,rollup",
    [id,range.first,range.last,extraPercent]);
   const values=Object.fromEntries(Object.entries(truth??{}).map(([k,v])=>[k,Number(v)]));
   if(Object.keys(values).length!==4||Object.values(values).some(v=>!Number.isSafeInteger(v)||v<=0))
    fail("financial_independent_oracle_missing");
   results.push({businessId:id,expenseId,monthlyId,annualId,from:range.first,to:range.last,monthlyLabel,annualLabel,oneTimeLabel,extraPercent,...values});
  }
  await db.query("COMMIT");
 }catch(error){await db.query("ROLLBACK");throw error}
 if(results.length!==2||results[0].break_even===results[1].break_even)fail("distinct_financial_oracles_required");
 return results;
}
export function assertU3FinancialEvidence({model,tools,text,oracle,proposals,sqlLog,foreignOracle}){
 requireObservedProductionModel(model,"gpt-6-luna");
 if(!Array.isArray(tools)||!tools.includes("query_data")||
  !hasCompletedSqlSources(sqlLog,[["expenses"],["recurring_costs"],["daily_rollups"]]))
  fail("financial_source_receipts_missing");
 // Labels make the oracle sensitive to which number answers which objective,
 // not just whether four unrelated amounts happen to occur in the response.
 for(const [label,expected] of [["recorded expense",oracle.actual],["recurring budget",oracle.budget],
  ["known-cost profit",oracle.known_profit],["break-even",oracle.break_even]]){
  const lines=text.split(/\n+/).filter(line=>line.toLowerCase().includes(label));
  if(!lines.some(line=>matchedMoney(line,expected)))fail("financial_answer_mismatch_"+label);
 }
 for(const label of [oracle.monthlyLabel,oracle.annualLabel,oracle.oneTimeLabel])
  if(!text.toLowerCase().includes(label.toLowerCase()))fail("financial_obligation_identity_missing");
 if(foreignOracle&&[foreignOracle.monthlyLabel,foreignOracle.annualLabel,foreignOracle.oneTimeLabel].some(label=>text.toLowerCase().includes(label.toLowerCase())))
  fail("foreign_financial_fact_visible");
 if(!/hypothetic|scenario|assumption/i.test(text)||!/estimate|recorded|known.cost/i.test(text)||proposals!==0)
  fail("financial_basis_or_effect_boundary");
}
async function observedObjectiveMetrics(db,businessId,usage,tools,sqlLog,elapsedMs){
 const [row]=await query(db,"SELECT output_tokens,estimated_cost_micros,execution_metrics FROM public.ai_usage_events WHERE business_id=$1 AND id=$2",[businessId,usage.id]);
 if(!row||!Number.isSafeInteger(row.output_tokens)||row.output_tokens<0||!Number.isSafeInteger(elapsedMs)||elapsedMs<0)
  fail("objective_usage_missing");
 const cost=row.estimated_cost_micros===null?null:Number(row.estimated_cost_micros);
 if(cost!==null&&(!Number.isSafeInteger(cost)||cost<0))fail("objective_cost_invalid");
 return {modelCalls:observedProviderCalls(usage),toolCalls:tools.length,completedSqlReceipts:completedSqlReceiptCount(sqlLog),
  inputTokens:Number(usage.input_tokens),outputTokens:row.output_tokens,estimatedCostMicros:cost,elapsedMs};
}
async function login(browser,cafe){
 const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
 const page=await context.newPage();
 await page.goto("/en/login");
 await page.locator("#email").fill(cafe.owner.email);
 await page.locator("#login-password").fill(cafe.owner.password);
 await page.locator("form button[type=submit]").click();
 await page.getByText(cafe.name,{exact:true}).first().waitFor({timeout:30000});
 return {context,page};
}
async function ownerTurn(page,thread,text){
 const clientMessageId=randomUUID();
 const result=await page.evaluate(async({thread,text,clientMessageId})=>{
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),180000);
  const names=[];let pending="",done=null,error=null;
  try{
   const response=await fetch("/api/ai/threads/"+thread+"/agent",{
    method:"POST",credentials:"same-origin",signal:ac.signal,
    headers:{"content-type":"application/json"},
    body:JSON.stringify({text,locale:"en",attachmentIds:[],clientMessageId})});
   if(!response.ok||!response.body)return {names,done,error:"agent_http_"+response.status};
   const reader=response.body.getReader(),decoder=new TextDecoder();
   while(!done&&!error){
    const frame=await reader.read();
    if(frame.done)break;
    pending+=decoder.decode(frame.value,{stream:true});
    let index;
    while((index=pending.indexOf("\n\n"))>=0){
     const lines=pending.slice(0,index).split("\n");pending=pending.slice(index+2);
     const event=lines.find(line=>line.startsWith("event: "))?.slice(7);
     const payload=lines.find(line=>line.startsWith("data: "))?.slice(6);
     let data=null;try{data=JSON.parse(payload??"null")}catch{}
     if(event==="tool"&&typeof data?.name==="string")names.push(data.name);
     if(event==="done"){done=data;break;}
     if(event==="error"){error=data?.code??"agent_error";break;}
    }
   }
   await reader.cancel().catch(()=>{});
   return {names,done,error:error??(done?null:"missing_complete_turn")};
  }catch{return {names,done,error:"transport_failed"}}
  finally{clearTimeout(timer)}
 },{thread,text,clientMessageId});
 if(result.error||result.done?.endReason!=="complete"||
  !/^[0-9a-f-]{36}$/i.test(result.done?.reply?.id??""))
  fail("registered_supervisor_turn_incomplete");
 return {...result,clientMessageId};
}
async function main(){
 const env=process.env;
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||
   env.AICAFE_SHARED_LUNA_SCENARIO!=="u3-canonical-research"||
   env.AICAFE_SHARED_LUNA_CANDIDATE!=="1")
  fail("explicit_shared_luna_authorization_required");
 requireNativeResearchHost(env);
 if(env.AICAFE_RESEARCH_SQL_ENABLED!=="true"||!env.AICAFE_RESEARCH_DATABASE_URL)
  fail("governed_research_connection_missing");
 // Trusted paid acceptance may run only against the disposable migrated DB.
 const researchURL=new URL(env.AICAFE_RESEARCH_DATABASE_URL);
 if(!["127.0.0.1","localhost"].includes(researchURL.hostname)||
   researchURL.port!=="54322"||researchURL.pathname!=="/postgres"||
   !["postgres:","postgresql:"].includes(researchURL.protocol)||
   decodeURIComponent(researchURL.username)!=="aicafe_research")
  fail("non_disposable_research_connection");
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")
  fail("private_output_and_scope_required");
 const {out,scopeOut}=resolveU3ProofPaths(args,env);
 const cafe=TEST_CAFES[0],other=TEST_CAFES[1];
 if(!cafe?.owner||!other?.owner||cafe.businessId===other.businessId)
  fail("two_disposable_cafes_required");
 const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 let owner=null,foreign=null;
 await db.connect();
 try{
  const {date,orders,lines}=await readU3Oracle(db,cafe.businessId);
  owner=await login(browser,cafe);
  const response=await owner.context.request.post("/api/ai/threads",{
   headers:{Origin:"http://127.0.0.1:3000"},
   data:{requestId:randomUUID(),title:"U3 source-backed analytical research"}});
  if(response.status()!==201)fail("thread_creation_failed");
  const thread=(await response.json()).thread?.id;
  if(!/^[0-9a-f-]{36}$/i.test(thread??""))fail("thread_id_missing");
  const serverLog=resolve(dirname(out),"next.log");
  const logStart=statSync(serverLog).size;
  const started=Date.now();
  const turn=await ownerTurn(owner.page,thread,
   "For "+date+", investigate this cafe's actual recorded order count, "+
   "order-line count and net sales, without multiplying the sales total "+
   "by joining to order lines. Use the available data sources, distinguish "+
   "recorded facts from missing coverage, and give "+cafe.currency+
   " with two decimals. This is research only: do not create or change anything.");
  const elapsedMs=Date.now()-started;
  const ownerMessage=await query(db,"SELECT id FROM public.ai_messages "+
   "WHERE business_id=$1 AND thread_id=$2 AND role='owner' AND client_message_id=$3",
   [cafe.businessId,thread,turn.clientMessageId]);
  if(ownerMessage.length!==1)fail("owner_message_missing");
  const usage=await readPersistedModelUsage(db,cafe.businessId,ownerMessage[0].id);
  const reply=await query(db,"SELECT structured_content FROM public.ai_messages "+
   "WHERE business_id=$1 AND thread_id=$2 AND role='supervisor' AND id=$3",
   [cafe.businessId,thread,turn.done.reply.id]);
  if(reply.length!==1)fail("saved_reply_missing");
  const blocks=reply[0].structured_content;
  if(!Array.isArray(blocks)||blocks.some(b=>b.type==="proposal_card"||b.type==="experiment_card"))
   fail("unexpected_effect_card");
  const text=blocks.filter(b=>b.type==="text").map(b=>b.text).join("");
  const proposals=await query(db,"SELECT count(*)::int n FROM public.supervisor_proposals "+
   "WHERE business_id=$1 AND thread_id=$2",[cafe.businessId,thread]);
  const log=readFileSync(serverLog);
  if(log.length<logStart)fail("research_log_replaced");
  const sqlReceipts=completedSqlReceiptCount(log.subarray(logStart).toString("utf8"));
  assertU3ObservedEvidence({model:usage.model,tools:turn.names,text,
   orders:orders.n,lines:lines.n,cents:Number(orders.cents),proposals:proposals[0]?.n,sqlReceipts});
  console.log("U3: committed SQL research receipts="+sqlReceipts+"; independent SQL answer verified.");
  const history=await seedU3HistoryOracle(db,cafe,other);
  const historicalLogStart=statSync(serverLog).size;
  const historicalStarted=Date.now();
  const historical=await ownerTurn(owner.page,thread,
   "From "+history.from+" through "+history.to+" inclusive, by recorded business date, how many total recorded orders did we have? "+
   "For local closing hours 11 PM through before 2 AM, including the after-midnight orders on their recorded business dates, "+
   "how many orders, how much recorded net sales ("+cafe.currency+", two decimals), and which sold item led by quantity and how many units? "+
   "Also give "+history.employeeName+"'s actual recorded clock history over that period, exact local clock-ins, clock-outs and recorded break start/end; "+
   "tell me which clock-out is missing. Distinguish actual observations from schedules. Research only; do not create or change anything.");
  const historicalElapsedMs=Date.now()-historicalStarted;
  const historicalMessages=await query(db,"SELECT id FROM public.ai_messages WHERE business_id=$1 AND thread_id=$2 AND role='owner' AND client_message_id=$3",
   [cafe.businessId,thread,historical.clientMessageId]);
  if(historicalMessages.length!==1)fail("historical_owner_message_missing");
  const historicalUsage=await readPersistedModelUsage(db,cafe.businessId,historicalMessages[0].id);
  const historicalReplies=await query(db,"SELECT structured_content FROM public.ai_messages WHERE business_id=$1 AND thread_id=$2 AND role='supervisor' AND id=$3",
   [cafe.businessId,thread,historical.done.reply.id]);
  if(historicalReplies.length!==1)fail("historical_reply_missing");
  const historicalBlocks=historicalReplies[0].structured_content;
  if(!Array.isArray(historicalBlocks)||historicalBlocks.some(b=>b.type==="proposal_card"||b.type==="experiment_card"))
   fail("unexpected_historical_effect_card");
  const historicalProposals=await query(db,"SELECT count(*)::int n FROM public.supervisor_proposals WHERE business_id=$1 AND thread_id=$2",[cafe.businessId,thread]);
  const historicalLog=readFileSync(serverLog);
  if(historicalLog.length<historicalLogStart)fail("research_log_replaced");
  const historicalSqlReceipts=completedSqlReceiptCount(historicalLog.subarray(historicalLogStart).toString("utf8"));
  assertU3HistoryEvidence({model:historicalUsage.model,tools:historical.names,
   text:historicalBlocks.filter(b=>b.type==="text").map(b=>b.text).join(""),oracle:history,
   proposals:historicalProposals[0]?.n,sqlReceipts:historicalSqlReceipts});
  console.log("U3: historical cross-domain independent source comparison verified.");
  foreign=await login(browser,other);
  const finance=await seedU3FinancialOracle(db,[cafe,other]);
  const objectives=[
   {id:"order-line-fanout",...await observedObjectiveMetrics(db,cafe.businessId,usage,turn.names,log.subarray(logStart).toString("utf8"),elapsedMs)},
   {id:"historical-cross-domain",...await observedObjectiveMetrics(db,cafe.businessId,historicalUsage,historical.names,historicalLog.subarray(historicalLogStart).toString("utf8"),historicalElapsedMs)}
  ];
  const financialScopes=[];
  for(const [i,identity] of [owner,foreign].entries()){
   const target=[cafe,other][i],oracle=finance[i];
   const response=await identity.context.request.post("/api/ai/threads",{
    headers:{Origin:"http://127.0.0.1:3000"},data:{requestId:randomUUID(),title:"U3 café financial analysis"}});
   if(response.status()!==201)fail("financial_thread_creation_failed");
   const financeThread=(await response.json()).thread?.id;
   if(!/^[0-9a-f-]{36}$/i.test(financeThread??""))fail("financial_thread_missing");
   const mark=statSync(serverLog).size,start=Date.now();
   const observed=await ownerTurn(identity.page,financeThread,
    "For "+oracle.from+" through "+oracle.to+", independently inspect my saved costs and sales. "+
    "List each recorded and recurring obligation by its own label, including actual versus estimated status. "+
    "Give the actual recorded expense total and the monthly-equivalent recurring budget (not extra incurred expenses). "+
    "Calculate known-cost profit from recorded net sales less recorded actual expenses, ingredients, processing fees, wages and payroll taxes. Do not certify completeness beyond the evidence. "+
    "For a hypothetical break-even, use the monthly-equivalent recurring commitments plus recorded wages and payroll taxes as fixed costs, "+
    "the recorded ingredient and processing-fee share of sales as variable costs, and an additional hypothetical "+oracle.extraPercent+"% of sales commission. "+
    "Give each of these four results in "+target.currency+" with two decimals, clearly labelled on separate lines: Recorded expense, Recurring budget, Known-cost profit, Break-even. "+
    "This is research and scenario analysis only; do not create or change anything.");
   const took=Date.now()-start;
   const [message]=await query(db,"SELECT id FROM public.ai_messages WHERE business_id=$1 AND thread_id=$2 AND role='owner' AND client_message_id=$3",[target.businessId,financeThread,observed.clientMessageId]);
   if(!message)fail("financial_owner_message_missing");
   const paid=await readPersistedModelUsage(db,target.businessId,message.id);
   const [saved]=await query(db,"SELECT structured_content FROM public.ai_messages WHERE business_id=$1 AND thread_id=$2 AND role='supervisor' AND id=$3",[target.businessId,financeThread,observed.done.reply.id]);
   if(!Array.isArray(saved?.structured_content)||saved.structured_content.some(b=>b.type==="proposal_card"||b.type==="experiment_card"))fail("financial_effect_card");
   const [effects]=await query(db,"SELECT count(*)::int n FROM public.supervisor_proposals WHERE business_id=$1 AND thread_id=$2",[target.businessId,financeThread]);
   const bytes=readFileSync(serverLog);if(bytes.length<mark)fail("financial_log_replaced");
   const sqlLog=bytes.subarray(mark).toString("utf8");
   assertU3FinancialEvidence({model:paid.model,tools:observed.names,text:saved.structured_content.filter(b=>b.type==="text").map(b=>b.text).join(""),
    oracle,foreignOracle:finance[1-i],proposals:effects?.n,sqlLog});
   objectives.push({id:"financial-cafe-"+(i+1),...await observedObjectiveMetrics(db,target.businessId,paid,observed.names,sqlLog,took)});
   financialScopes.push({threadId:financeThread,replyId:observed.done.reply.id,expenseId:oracle.expenseId,monthlyId:oracle.monthlyId,annualId:oracle.annualId});
  }
  const denied=await foreign.context.request.get("/api/ai/threads/"+thread);
  if(![401,403,404].includes(denied.status()))fail("cross_cafe_thread_visible");
  const scope={businessId:cafe.businessId,otherCafeId:other.businessId,
   ownerUserId:cafe.owner.userId,threadId:thread,replyId:turn.done.reply.id,
   businessDate:date,sampleOrderId:lines.sample_order_id,
   orderCount:orders.n,lineCount:lines.n,netCents:String(orders.cents),
   historicalReplyId:historical.done.reply.id,historicalEmployeeId:history.employeeId,
   historicalOrderId:history.night.sample_id,historicalTimecardId:history.timecardId,historicalOpenTimecardId:history.openCardId,
   financialThreadId:financialScopes[0].threadId,financialReplyId:financialScopes[0].replyId,financialExpenseId:financialScopes[0].expenseId,
   otherFinancialThreadId:financialScopes[1].threadId,otherFinancialReplyId:financialScopes[1].replyId,otherFinancialExpenseId:financialScopes[1].expenseId,
   expectedProviderCalls:objectives.reduce((sum,objective)=>sum+objective.modelCalls,0)};
  writeFileSync(out,JSON.stringify({id:"u3-canonical-research",schema_version:1,
   head_sha:env.HEAD_SHA,status:"passed",observed_model:usage.model,
   checks:{sourceMatch:true,registeredResearch:true,committedSqlResearch:true,foreignDenied:true,noEffect:true},
   completedSqlReceipts:objectives.reduce((sum,objective)=>sum+objective.completedSqlReceipts,0),
   financialCrossCafe:true,objectives,
   historicalCrossDomain:true,historicalElapsedMs,
   nativeResearchHost:env.AICAFE_SHARED_LUNA_NATIVE_RESEARCH==="1",
   observedModelCalls:scope.expectedProviderCalls})+"\n",{mode:0o600,flag:"wx"});
  writeFileSync(scopeOut,JSON.stringify(scope)+"\n",{mode:0o600,flag:"wx"});
 }finally{
  await foreign?.context.close().catch(()=>{});
  await owner?.context.close().catch(()=>{});
  await browser.close().catch(()=>{});
  await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error(e instanceof Error?e.message:"u3_canonical_research_live:unknown");process.exitCode=1});
