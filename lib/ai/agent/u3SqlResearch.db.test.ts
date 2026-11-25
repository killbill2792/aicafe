import {randomBytes,randomUUID} from "node:crypto";
import {Client} from "pg";
import {performance} from "node:perf_hooks";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";

vi.mock("server-only",()=>({}));
const bridge=vi.hoisted(()=>({
 call:null as null|((name:string,input:Record<string,unknown>)=>Promise<{
  data:unknown;error:{message:string}|null
 }>)
}));
vi.mock("@/lib/supabase/admin",()=>({
 createAdminSupabaseClient:()=>({
  rpc:async(name:string,input:Record<string,unknown>)=>
   bridge.call?.(name,input)??{data:null,error:{message:"local_source_unavailable"}}
 })
}));
import {dataQueryTools} from "./tools/dataQuery";
import {ResearchPageCollector,researchPageCache} from "./tools/u3SqlPageCache";
import {compactEvidence,checkNumbers} from "./checkNumbers";
import {executeAgentTool,type AgentToolResult,type AgentToolContext} from "./tools";

// The only database accepted by this proof is a migrated disposable localhost
// Supabase fixture. Nothing in this suite can reach a production project.
const active=process.env.U3_SQL_DB_SANDBOX_ONLY==="1";
const connection=process.env.U3_SQL_DB_URL;
const ids={
 a:randomUUID(),b:randomUUID(),oa:randomUUID(),ob:randomUUID(),
 ta:randomUUID(),tb:randomUUID(),orderA:randomUUID(),orderB:randomUUID(),
 lineA:randomUUID(),lineB:randomUUID()
};
let admin:Client|null=null;
let password="";
const priorFlag=process.env.AICAFE_RESEARCH_SQL_ENABLED;
const priorUrl=process.env.AICAFE_RESEARCH_DATABASE_URL;
const priorCursorSecret=process.env.SUPABASE_SERVICE_ROLE_KEY;
const scoped={db:{} as never,businessId:ids.a,ownerUserId:ids.oa,
 threadId:ids.ta,mode:"owner" as const};
const input=(sql:string)=>({
 view:null,sql,parameters:[],columns:null,filters:null,group_by:null,
 metrics:null,date_from:null,date_to:null,order_by:null,limit:10
});
describe.skipIf(!active)("U3 migrated registered tool + private connection",()=>{
 it("discovers saved public event provenance and current cafe associations without foreign cafe links",async()=>{
  if(!admin)throw Error("test admin unavailable");
  const publicEvents=[randomUUID(),randomUUID()],localEvents=[randomUUID(),randomUUID()];
  const day="2025-01-18";
  try{
   for(const [index,business] of [ids.a,ids.b].entries()){
    await admin.query("INSERT INTO public.city_events(id,city_key,identity_key,name,kind,start_date,end_date,last_checked_at) VALUES($1,$2,$3,$4,'festival',$5,$5,now())",[publicEvents[index],"synthetic-city",randomBytes(32).toString("hex"),"Synthetic public festival "+index,day]);
    await admin.query("INSERT INTO public.city_event_sources(city_event_id,source_url,observed_name,observed_at) VALUES($1,$2,$3,now())",[publicEvents[index],"https://example.invalid/event/"+index,"Synthetic public festival "+index]);
    await admin.query("INSERT INTO public.cafe_events(id,business_id,name,kind,start_date,end_date) VALUES($1,$2,$3,'holiday',$4,$4)",[localEvents[index],business,"Synthetic local event "+index,day]);
    await admin.query("INSERT INTO public.cafe_city_event_links(business_id,cafe_event_id,city_event_id) VALUES($1,$2,$3)",[business,localEvents[index],publicEvents[index]]);
   }
   const result=await dataQueryTools.query_data.execute(input("SELECT e.name,s.source_url FROM cafe_city_event_links l JOIN city_events e ON e.id=l.city_event_id JOIN city_event_sources s ON s.city_event_id=e.id WHERE e.city_key='synthetic-city'"),scoped);
   expect(result.error).toBeUndefined();
   expect(result.rows).toEqual([{name:"Synthetic public festival 0",source_url:"https://example.invalid/event/0"}]);
   const menu=await dataQueryTools.query_data.execute(input("SELECT description,prep_seconds,pos_pricing_strategy,pos_archived_at FROM menu_items WHERE false"),scoped);
   expect(menu.error).toBeUndefined();
  }finally{
   await admin.query("DELETE FROM public.cafe_city_event_links WHERE cafe_event_id=ANY($1::uuid[])",[localEvents]);
   await admin.query("DELETE FROM public.cafe_events WHERE id=ANY($1::uuid[])",[localEvents]);
   await admin.query("DELETE FROM public.city_event_sources WHERE city_event_id=ANY($1::uuid[])",[publicEvents]);
   await admin.query("DELETE FROM public.city_events WHERE id=ANY($1::uuid[])",[publicEvents]);
  }
 });

 beforeAll(async()=>{
  if(!connection)throw Error("U3_SQL_DB_URL missing");
  const u=new URL(connection);
  if(!["127.0.0.1","localhost"].includes(u.hostname)||
    u.port!=="54322"||u.pathname!=="/postgres"||
    !["postgres:","postgresql:"].includes(u.protocol))
   throw Error("U3 DB proof refuses non-disposable database");
  admin=new Client({connectionString:connection,connectionTimeoutMillis:4000});
  await admin.connect();
  const role=await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='aicafe_research'");
  if(role.rows.length!==1||role.rows[0].rolcanlogin!==false)
   throw Error("U3 dedicated research role must begin NOLOGIN");
  password=randomBytes(24).toString("hex");
  // A test-only role password generated for this disposable instance. Never
  // log it, share it, or use a production credential. Cleanup restores NOLOGIN.
  await admin.query("ALTER ROLE aicafe_research LOGIN PASSWORD '"+password+"'");
  const researchUrl=new URL(connection);
  researchUrl.username="aicafe_research";
  researchUrl.password=password;
  process.env.AICAFE_RESEARCH_DATABASE_URL=researchUrl.toString();
  process.env.AICAFE_RESEARCH_SQL_ENABLED="true";
  // Synthetic signing key is allowed only for this disposable test fixture.
  process.env.SUPABASE_SERVICE_ROLE_KEY=priorCursorSecret??randomBytes(32).toString("hex");
  await admin.query(
   "INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) "+
   "VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',"+
   "'u3-db-owner-a@example.invalid','',now(),now()),"+
   "($2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',"+
   "'u3-db-owner-b@example.invalid','',now(),now())",[ids.oa,ids.ob]);
  await admin.query("INSERT INTO public.businesses(id,name,is_demo,timezone,currency) "+
    "VALUES($1,'U3 test-only A',false,'UTC','USD'),"+
    "($2,'U3 test-only B',false,'UTC','USD')",[ids.a,ids.b]);
  await admin.query("INSERT INTO public.memberships(business_id,user_id,role) "+
    "VALUES($1,$2,'owner'),($3,$4,'owner')",[ids.a,ids.oa,ids.b,ids.ob]);
  await admin.query("INSERT INTO public.ai_threads(id,business_id,owner_user_id,client_request_id) "+
    "VALUES($1,$2,$3,gen_random_uuid()),($4,$5,$6,gen_random_uuid())",
    [ids.ta,ids.a,ids.oa,ids.tb,ids.b,ids.ob]);
  await admin.query("INSERT INTO public.orders(id,business_id,pos_order_id,closed_at,business_date,"+
    "gross_sales_cents,net_sales_cents) "+
    "VALUES($1,$2,'u3-synthetic-a',now(),current_date,1100,1100),"+
    "($3,$4,'u3-synthetic-b',now(),current_date,4200,4200)",
    [ids.orderA,ids.a,ids.orderB,ids.b]);
  await admin.query("INSERT INTO public.order_lines(id,order_id,name,quantity,net_sales_cents) "+
    "VALUES($1,$2,'Synthetic item A',1,1100),($3,$4,'Synthetic item B',1,4200)",
    [ids.lineA,ids.orderA,ids.lineB,ids.orderB]);
  // The fixture shares one administrative connection for scope minting.
  // Serialize that transaction, not the real research pool or queries.
  let mintTail:Promise<void>=Promise.resolve();
  bridge.call=(name,p)=>{
   const issue=mintTail.then(async()=>{
   if(!admin)return {data:null,error:{message:"admin_unavailable"}};
   await admin.query("BEGIN");
   try{
    await admin.query("SELECT set_config('request.jwt.claim.role','service_role',true)");
    const scope=[p.p_business_id,p.p_owner_user_id,p.p_thread_id,p.p_mode,p.p_source_type,
     p.p_source_id,p.p_run_id,p.p_lease_token];
    const call=name==="u3_issue_research_scope"
     ?await admin.query("SELECT public.u3_issue_research_scope($1,$2,$3,$4,$5,$6,$7,$8) AS result",scope)
     :name==="u3_query_snapshot_chunk"
      ?await admin.query("SELECT public.u3_query_snapshot_chunk($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS result",
       [...scope,p.p_snapshot_id,p.p_start_row,p.p_row_count,p.p_ciphertext])
      :null;
    if(!call)throw Error("unexpected research RPC");
    await admin.query("COMMIT");
    return {data:call.rows[0]?.result??null,error:null};
   }catch{
    await admin.query("ROLLBACK").catch(()=>{});
    return {data:null,error:{message:"scope_denied"}};
   }
   });
   mintTail=issue.then(()=>undefined,()=>undefined);
   return issue;
  };
 });
 afterAll(async()=>{
  bridge.call=null;
  if(admin){
   // The active source is disposable. Do not leave an interactive research
   // credential or synthetic business record after the acceptance test.
   await admin.query("DELETE FROM public.order_lines WHERE id IN ($1,$2)",
    [ids.lineA,ids.lineB]).catch(()=>{});
   await admin.query("DELETE FROM public.orders WHERE id IN ($1,$2)",
    [ids.orderA,ids.orderB]).catch(()=>{});
   await admin.query("DELETE FROM public.ai_threads WHERE id IN ($1,$2)",
    [ids.ta,ids.tb]).catch(()=>{});
   await admin.query("DELETE FROM public.memberships WHERE business_id IN ($1,$2)",
    [ids.a,ids.b]).catch(()=>{});
   await admin.query("DELETE FROM public.businesses WHERE id IN ($1,$2)",
    [ids.a,ids.b]).catch(()=>{});
   await admin.query("DELETE FROM auth.users WHERE id IN ($1,$2)",
    [ids.oa,ids.ob]).catch(()=>{});
   await admin.query("ALTER ROLE aicafe_research NOLOGIN PASSWORD NULL").catch(()=>{});
   await admin.end().catch(()=>{});
  }
  if(priorFlag===undefined)delete process.env.AICAFE_RESEARCH_SQL_ENABLED;
  else process.env.AICAFE_RESEARCH_SQL_ENABLED=priorFlag;
  if(priorUrl===undefined)delete process.env.AICAFE_RESEARCH_DATABASE_URL;
  else process.env.AICAFE_RESEARCH_DATABASE_URL=priorUrl;
  if(priorCursorSecret===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY=priorCursorSecret;
 });
 it("queries original workflow facts and retains strict owner-private access",async()=>{
  if(!admin)throw Error("admin_missing");
  const a=randomUUID(),b=randomUUID();
  try{
   await admin.query("INSERT INTO public.alerts(id,business_id,kind,impact_cents,payload,status) VALUES($1,$2,'meal_break',1200,'{}','new'),($3,$4,'meal_break',9900,'{}','new')",[a,ids.a,b,ids.b]);
   const result=await dataQueryTools.query_data.execute({...input("SELECT id,impact_cents FROM alerts WHERE id IN ($1,$2)"),parameters:[a,b]},scoped);
   expect(result.error).toBeUndefined();
   expect(result.rows).toEqual([{id:a,impact_cents:"1200"}]);
   for(const relation of ["operating_tasks","alerts","supervisor_proposals","supplier_proposal_lines","supervisor_effect_attempts","supervisor_reports","supervisor_monitor_windows","purchase_order_dispatches","purchase_order_channel_reports","purchase_order_events","cafe_supplier_order_contacts","supplier_po_draft_replacements"]){
    const result=await dataQueryTools.query_data.execute(input("SELECT count(*) FROM "+relation),scoped);
    expect(result.error).toBeUndefined();
    const denied=await dataQueryTools.query_data.execute(input("SELECT count(*) FROM "+relation),{...scoped,aggregateOnly:true});
    expect(denied.error).toBeDefined();
   }
  }finally{await admin.query("DELETE FROM public.alerts WHERE id IN ($1,$2)",[a,b]);}
 });
 it("reads saved staffing cases across their full history without crossing café scope",async()=>{
  if(!admin)throw Error("admin_missing");
  const a=randomUUID(),b=randomUUID();
  try{
   await admin.query("INSERT INTO public.staff_coordination_cases(id,business_id,source_kind,source_key,case_kind,role_needed) VALUES($1,$2,'owner_record',$1::uuid::text,'recruitment','Local role'),($3,$4,'owner_record',$3::uuid::text,'recruitment','Foreign role')",[a,ids.a,b,ids.b]);
   await admin.query("INSERT INTO public.staff_coordination_evidence(business_id,case_id,evidence_key,source_kind,source_id,source_revision) VALUES($1,$2,'decision','owner_decision','local','1'),($3,$4,'decision','owner_decision','foreign','1')",[ids.a,a,ids.b,b]);
   const result=await dataQueryTools.query_data.execute(input("SELECT c.role_needed,e.source_id FROM staff_coordination_cases c JOIN staff_coordination_evidence e ON e.case_id=c.id"),scoped);
   expect(result.error).toBeUndefined();
   expect(result.rows).toEqual([{role_needed:"Local role",source_id:"local"}]);
   for(const relation of ["staff_communication_requests","staff_communication_messages","staff_coordination_cases","staff_coordination_evidence","maintenance_cases","maintenance_case_events"]){
    const result=await dataQueryTools.query_data.execute(input("SELECT count(*) FROM "+relation),{...scoped,aggregateOnly:true});
    expect(result.error).toBeDefined();
   }
  }finally{await admin.query("DELETE FROM public.staff_coordination_cases WHERE id IN ($1,$2)",[a,b]);}
 });
 it("reads all saved normalized statement transactions through general SQL without crossing owner scope",async()=>{
  if(!admin)throw Error("admin_missing");
  const day="2026-01-01";
  const docs:string[]=[];
  try{
   for(const [business,owner,count,amount] of [[ids.a,ids.oa,600,125],[ids.b,ids.ob,2,900]] as const){
    const rows=Array.from({length:count},(_,i)=>({i,date:day,amountCents:amount,balanceCents:(i+1)*amount}));
    await admin.query("BEGIN");
    try{
     await admin.query("SELECT set_config('request.jwt.claim.role','service_role',true)");
     const saved=await admin.query("SELECT public.supervisor_record_statement_evidence($1,$2,$3,$4,'USD',$5,$5,0,$6,$7::jsonb) AS id",[business,owner,randomBytes(32).toString("hex"),randomBytes(32).toString("hex"),day,count*amount,JSON.stringify(rows)]);
     docs.push(saved.rows[0].id);
     await admin.query("COMMIT");
    }catch(e){await admin.query("ROLLBACK");throw e;}
   }
   const result=await dataQueryTools.query_data.execute(input("SELECT count(*) AS transactions,sum(t.amount_cents) AS movement_cents,max(d.closing_cents) AS closing_cents FROM financial_statement_transactions t JOIN financial_statement_documents d ON d.statement_id=t.statement_id"),scoped);
   expect(result.error).toBeUndefined();
   expect(result.rows).toEqual([{transactions:"600",movement_cents:"75000",closing_cents:"75000"}]);
   const denied=await dataQueryTools.query_data.execute(input("SELECT count(*) FROM financial_statement_transactions"),{...scoped,aggregateOnly:true});
   expect(denied.error).toBeDefined();
   expect(denied.rows??[]).toEqual([]);
  }finally{if(docs.length)await admin.query("DELETE FROM public.uploads WHERE id=ANY($1::uuid[])",[docs]);}
 });
 it("researches saved event decisions, checklist states and historical observations without the event preview date ceiling",async()=>{
  if(!admin)throw Error("admin_missing");
  const plans=[randomUUID(),randomUUID()],events=[randomUUID(),randomUUID()];
  const day="2025-01-05";
  try{
   for(const [index,business,owner,thread,amount] of [[0,ids.a,ids.oa,ids.ta,2300],[1,ids.b,ids.ob,ids.tb,9999]] as const){
    await admin.query("INSERT INTO public.cafe_events(id,business_id,name,kind,start_date,end_date) VALUES($1,$2,$3,'holiday',$4,$4)",[events[index],business,"Synthetic event "+index,day]);
    const effect={startDate:day,endDate:day,eventIds:[events[index]],summary:"Synthetic plan "+index,importance:"medium",expectedBusyHours:[],actions:[{area:"prep",action:"Prepare extra cups",reason:"Observed demand"}]};
    await admin.query("INSERT INTO public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale) VALUES($1,$2,$3,$4,gen_random_uuid(),'alex.event_readiness.v1',1,$5::jsonb,repeat('a',64),'{}','{}','en')",[plans[index],business,owner,thread,JSON.stringify(effect)]);
    await admin.query("INSERT INTO public.supervisor_monitor_samples(business_id,proposal_id,business_date,observation,evidence_source) VALUES($1,$2,$3,$4::jsonb,'daily_rollups')",[business,plans[index],day,JSON.stringify({coverage:"actual",actualCents:amount,typicalCents:2000,baselineDays:4})]);
   }
   const result=await dataQueryTools.query_data.execute(input("SELECT e.name,a.checklist_state,o.actual_cents,o.typical_cents FROM event_readiness_links l JOIN cafe_events e ON e.id::text=l.event_id JOIN event_readiness_actions a ON a.plan_id=l.plan_id JOIN event_readiness_observations o ON o.plan_id=l.plan_id WHERE o.business_date < CURRENT_DATE - 90"),scoped);
   expect(result.error).toBeUndefined();
   expect(result.rows).toEqual([{name:"Synthetic event 0",checklist_state:"pending",actual_cents:"2300",typical_cents:"2000"}]);
  }finally{
   await admin.query("DELETE FROM public.supervisor_proposals WHERE id=ANY($1::uuid[])",[plans]);
   await admin.query("DELETE FROM public.cafe_events WHERE id=ANY($1::uuid[])",[events]);
  }
 });
 it("preserves unfamiliar actual expense labels and recurring links across the real SQL surface",async()=>{
  if(!admin)throw Error("admin_missing");
  const cost=randomUUID(),expense=randomUUID(),foreign=randomUUID();
  try{
   await admin.query("INSERT INTO public.recurring_costs(id,business_id,category_code,label,amount_cents,frequency,is_estimate,active_from,source) VALUES($1,$2,'repairs','Synthetic periodic maintenance',1234,'monthly',false,current_date,'owner')",[cost,ids.a]);
   await admin.query("INSERT INTO public.expenses(id,business_id,spent_on,amount_cents,category_code,source,status,dedupe_key,custom_label,recurring_cost_id) VALUES($1,$2,current_date,1234,'repairs','manual','actual',$1::uuid::text,'Synthetic uncommon expense',$3)",[expense,ids.a,cost]);
   await admin.query("INSERT INTO public.expenses(id,business_id,spent_on,amount_cents,category_code,source,status,dedupe_key,custom_label) VALUES($1,$2,current_date,9876,'repairs','manual','actual',$1::uuid::text,'Foreign synthetic expense')",[foreign,ids.b]);
   const result=await dataQueryTools.query_data.execute(input("SELECT e.custom_label,e.amount_cents,r.label AS commitment FROM expenses e LEFT JOIN recurring_costs r ON e.recurring_cost_id=r.id"),scoped);
   expect(result.missing).toEqual([]);
   expect(JSON.stringify(result)).toContain("Synthetic uncommon expense");
   expect(JSON.stringify(result)).toContain("Synthetic periodic maintenance");
   expect(JSON.stringify(result)).not.toContain("Foreign synthetic expense");
  }finally{
   await admin.query("DELETE FROM public.expenses WHERE id IN ($1,$2)",[expense,foreign]);
   await admin.query("DELETE FROM public.recurring_costs WHERE id=$1",[cost]);
  }
 });
 it("researches saved supplier quotes, dated stock counts and goal observations through one scoped SQL surface",async()=>{
  if(!admin)throw Error("admin_missing");
  const ingredientA=randomUUID(),ingredientB=randomUUID(),quoteA=randomUUID(),quoteB=randomUUID(),goalA=randomUUID(),goalB=randomUUID();
  const day="2026-11-22";
  const effect=(title:string)=>({title,days:14,proposedOn:"2026-11-01",baselineFrom:"2026-10-18",baselineTo:"2026-10-31",currency:"USD",
   metrics:[{id:"primary",role:"primary",metricKey:"net_sales",itemId:null,itemName:null,comparator:"gte",targetKind:"relative_pct",target:10}]});
  try{
   await admin.query("INSERT INTO public.ingredients(id,business_id,name,base_unit) VALUES($1,$2,'Local synthetic milk','ml'),($3,$4,'Foreign synthetic milk','ml')",[ingredientA,ids.a,ingredientB,ids.b]);
   await admin.query("INSERT INTO public.pantry_stock_counts(business_id,ingredient_id,count_date,quantity_base,entered_quantity,entered_unit) VALUES($1,$2,$5,0,0,'ml'),($3,$4,$5,999,999,'ml')",[ids.a,ingredientA,ids.b,ingredientB,day]);
   await admin.query("INSERT INTO public.ai_supplier_quotes(id,business_id,owner_user_id,client_request_id,supplier_name,item_name,ingredient_id,price_cents,package_count,package_unit,source_kind,quoted_on,currency_code) VALUES($1,$2,$3,gen_random_uuid(),'Local supplier','Milk',$4,450,1,'gal','supplier_quote',$9,'USD'),($5,$6,$7,gen_random_uuid(),'Foreign supplier','Milk',$8,999,1,'gal','supplier_quote',$9,'USD')",[quoteA,ids.a,ids.oa,ingredientA,quoteB,ids.b,ids.ob,ingredientB,day]);
   for(const [id,business,owner,thread,title,amount] of [[goalA,ids.a,ids.oa,ids.ta,"Local goal",12500],[goalB,ids.b,ids.ob,ids.tb,"Foreign goal",99999]] as const){
    await admin.query("INSERT INTO public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale) VALUES($1,$2,$3,$4,gen_random_uuid(),'leo.goal.v1',1,$5::jsonb,repeat('a',64),'{}','{}','en')",[id,business,owner,thread,JSON.stringify(effect(title))]);
    await admin.query("INSERT INTO public.supervisor_monitor_samples(business_id,proposal_id,business_date,observation,evidence_source) VALUES($1,$2,$3,$4::jsonb,'daily_rollups')",[business,id,day,JSON.stringify({values:{primary:{value:amount,coverage:1}},baseline:{primary:[{date:"2026-10-25",value:10000,coverage:1}]}})]);
   }
   const stock=await dataQueryTools.query_data.execute(input("SELECT ingredient_name,quantity,quantity_unit,evidence_state FROM inventory_observations WHERE source='app'"),scoped);
   expect(stock.error).toBeUndefined();
   expect(stock.rows).toEqual([{ingredient_name:"Local synthetic milk",quantity:"0.0000",quantity_unit:"ml",evidence_state:"dated_owner_count"}]);
   const quotes=await dataQueryTools.query_data.execute(input("SELECT supplier_name,price_cents,currency_code FROM supplier_quotes"),scoped);
   expect(quotes.error).toBeUndefined();
   expect(quotes.rows).toEqual([{supplier_name:"Local supplier",price_cents:450,currency_code:"USD"}]);
   const goal=await dataQueryTools.query_data.execute(input("SELECT g.title,o.value_cents,o.coverage_ratio FROM goal_metrics g JOIN goal_observations o ON g.goal_id=o.goal_id AND g.metric_id=o.metric_id WHERE o.observation_kind='test'"),scoped);
   expect(goal.error).toBeUndefined();
   expect(goal.rows).toEqual([{title:"Local goal",value_cents:"12500",coverage_ratio:"1"}]);
   for(const relation of ["supplier_quotes","goal_metrics","goal_observations","goal_checkins"]){
    const denied=await dataQueryTools.query_data.execute(input("SELECT COUNT(*) AS n FROM "+relation),{...scoped,aggregateOnly:true});
    expect(denied.error).toBe("unattended_aggregate_required");
   }
  }finally{
   await admin.query("DELETE FROM public.supervisor_proposals WHERE id IN ($1,$2)",[goalA,goalB]);
   await admin.query("DELETE FROM public.ai_supplier_quotes WHERE id IN ($1,$2)",[quoteA,quoteB]);
   await admin.query("DELETE FROM public.pantry_stock_counts WHERE ingredient_id IN ($1,$2)",[ingredientA,ingredientB]);
   await admin.query("DELETE FROM public.ingredients WHERE id IN ($1,$2)",[ingredientA,ingredientB]);
  }
 });
 it("discovers admitted relational sources through the real scoped SQL catalog",async()=>{
  const context={asOf:"2026-11-24",timezone:"UTC",locale:"en",
   tools:{} as AgentToolContext["tools"],canonicalData:async()=>scoped} satisfies AgentToolContext;
  const d=await executeAgentTool("describe_data",{source:"research",search:"orders"},context);
  expect(d.missing).toEqual([]);
  expect(d.source).toBe("u3_semantic_catalog");
  expect(JSON.stringify(d)).toContain("orders");
  expect(JSON.stringify(d)).not.toContain("connector_credentials");
  expect(JSON.stringify(d)).toContain("net_sales_cents");
  expect(JSON.stringify(d)).toContain("business_date");
 });
 it("exposes actual café settings and current scalar owner facts without cross-café leakage",async()=>{
  if(!admin)throw Error("admin_missing");
  await admin.query("UPDATE public.businesses SET owner_monthly_payroll_extras_cents=12345 WHERE id=$1",[ids.a]);
  await admin.query("UPDATE public.businesses SET owner_monthly_payroll_extras_cents=67890 WHERE id=$1",[ids.b]);
  await admin.query("INSERT INTO public.owner_facts(business_id,fact_key,value_json,unit,source,created_by) VALUES ($1,'u3_test_equipment_lease','12345'::jsonb,'cents','owner',$2),($3,'u3_test_equipment_lease','67890'::jsonb,'cents','owner',$4)",[ids.a,ids.oa,ids.b,ids.ob]);
  const settings=await dataQueryTools.query_data.execute(input("SELECT currency,owner_monthly_payroll_extras_cents FROM cafe_settings"),scoped);
  expect(settings.error).toBeUndefined();
  expect(settings.rows).toHaveLength(1);
  expect(Number((settings.rows[0] as Record<string,unknown>).owner_monthly_payroll_extras_cents)).toBe(12345);
  const facts=await dataQueryTools.query_data.execute(input("SELECT fact_key,numeric_value,unit FROM current_owner_facts"),scoped);
  expect(facts.error).toBeUndefined();
  expect(facts.rows).toHaveLength(1);
  expect(Number((facts.rows[0] as Record<string,unknown>).numeric_value)).toBe(12345);
  const denied=await dataQueryTools.query_data.execute(input("SELECT COUNT(*) AS n FROM current_owner_facts"),{...scoped,aggregateOnly:true});
  expect(denied.error).toBe("unattended_aggregate_required");
  await admin.query("UPDATE public.owner_facts SET superseded_at=now() WHERE business_id=$1 AND fact_key='u3_test_equipment_lease'",[ids.a]);
  const superseded=await dataQueryTools.query_data.execute(input("SELECT fact_key,numeric_value FROM current_owner_facts"),scoped);
  expect(superseded.error).toBeUndefined();
  expect(superseded.rows).toEqual([]);
 });
 it("joins provider planned shifts to the exact saved roster identity, without matching by name",async()=>{
  if(!admin)throw Error("admin_missing");
  const loc=[randomUUID(),randomUUID()],restaurants=[randomUUID(),randomUUID()],employees=[randomUUID(),randomUUID()],externalEmployee=randomUUID();
  try{
   for(const [i,business] of [ids.a,ids.b].entries()){
    await admin.query("INSERT INTO public.locations(id,business_id,name,timezone) VALUES($1,$2,$3,'UTC')",[loc[i],business,"Synthetic roster location "+i]);
    await admin.query("INSERT INTO public.employees(id,business_id,display_name,min_weekly_minutes,max_weekly_minutes) VALUES($1,$2,$3,600,1200)",[employees[i],business,"Owner team name "+i]);
    await admin.query("INSERT INTO public.toast_api_credentials(business_id,api_origin,client_id,client_secret_enc) VALUES($1,'https://example.invalid','fixture_only','synthetic_ciphertext')",[business]);
    await admin.query("INSERT INTO public.toast_location_mappings(business_id,location_id,restaurant_guid) VALUES($1,$2,$3)",[business,loc[i],restaurants[i]]);
    await admin.query("INSERT INTO public.toast_employee_directory(business_id,restaurant_guid,employee_guid,display_name,linked_employee_id,linked_at,fetched_at) VALUES($1,$2,$3,'Duplicate provider name',$4,now(),now())",[business,restaurants[i],externalEmployee,employees[i]]);
    await admin.query("INSERT INTO public.pos_scheduled_shifts(business_id,location_id,provider,external_shift_id,external_employee_id,scheduled_start,scheduled_end,last_synced_at) VALUES($1,$2,'toast',$3,$4,'2025-01-01T08:00:00Z','2025-01-01T12:00:00Z',now())",[business,loc[i],"synthetic-shift-"+i,externalEmployee]);
   }
   const result=await dataQueryTools.query_data.execute(input("SELECT p.external_shift_id,e.display_name,e.min_weekly_minutes FROM pos_scheduled_shifts p JOIN toast_location_mappings m ON p.location_id=m.location_id JOIN toast_employee_directory d ON d.restaurant_guid=m.restaurant_guid AND d.employee_guid::text=p.external_employee_id JOIN employees e ON e.id=d.linked_employee_id WHERE p.provider='toast' AND NOT p.deleted"),scoped);
   expect(result.error).toBeUndefined();
   expect(result.rows).toEqual([{external_shift_id:"synthetic-shift-0",display_name:"Owner team name 0",min_weekly_minutes:600}]);
  }finally{
   await admin.query("DELETE FROM public.pos_scheduled_shifts WHERE location_id=ANY($1::uuid[])",[loc]);
   await admin.query("DELETE FROM public.toast_employee_directory WHERE restaurant_guid=ANY($1::uuid[])",[restaurants]);
   await admin.query("DELETE FROM public.toast_location_mappings WHERE location_id=ANY($1::uuid[])",[loc]);
   await admin.query("DELETE FROM public.toast_api_credentials WHERE business_id=ANY($1::uuid[]) AND client_id='fixture_only'",[[ids.a,ids.b]]);
   await admin.query("DELETE FROM public.employees WHERE id=ANY($1::uuid[])",[employees]);
   await admin.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])",[loc]);
  }
 });
 it("uses the same authenticated business facts in interactive and durable owner research",async()=>{
  if(!admin)throw Error("admin_missing");
  const employeeA=randomUUID(),employeeB=randomUUID(),message=randomUUID();
  await admin.query("INSERT INTO public.employees(id,business_id,display_name,default_hourly_wage_cents) VALUES($1,$2,'Synthetic staff A',2100),($3,$4,'Synthetic staff B',3200)",[employeeA,ids.a,employeeB,ids.b]);
  await admin.query("INSERT INTO public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id) VALUES($1,$2,$3,$4,$3,'owner','text','Synthetic durable research',gen_random_uuid())",[message,ids.a,ids.oa,ids.ta]);
  await admin.query("SELECT set_config('request.jwt.claim.role','service_role',false)");
  let runId:string|undefined;
  try{
   const scope=[ids.a,ids.oa,ids.ta];
   const admitted=(await admin.query("SELECT public.supervisor_admit_owner_run_v2($1,$2,$3,$4,$5,$6,$7) AS result",[...scope,message,"c".repeat(64),"en",[]])).rows[0].result;
   runId=admitted.id;
   const claim=async()=>(await admin!.query("SELECT public.supervisor_run_claim($1,$2,$3,$4,$5,30) AS result",[...scope,runId,randomUUID()])).rows[0].result;
   const auth=await claim();
   expect(auth.step.step_key).toBe("authorize_owner");
   await admin.query("SELECT public.supervisor_run_complete_step($1,$2,$3,$4,$5,$6,$7)",[...scope,runId,"authorize_owner",auth.step.claim_token,"owner:"+message]);
   const ownerTurn=await claim();
   expect(ownerTurn.step.step_key).toBe("owner_turn");
   const durable={...scoped,mode:"durable" as const,runId,leaseToken:ownerTurn.step.claim_token};
   const sql=input("SELECT id,display_name,default_hourly_wage_cents FROM employees ORDER BY id");
   const interactive=await dataQueryTools.query_data.execute(sql,scoped);
   const resumed=await dataQueryTools.query_data.execute(sql,durable);
   expect(interactive.rows).toEqual([{id:employeeA,display_name:"Synthetic staff A",default_hourly_wage_cents:"2100"}]);
   expect(resumed.error).toBeUndefined();
   expect(resumed.rows).toEqual(interactive.rows);
   expect((await dataQueryTools.query_data.execute(input("SELECT count(*) AS n FROM staff_schedules"),{...durable,aggregateOnly:true})).error).toBe("unattended_aggregate_required");
   await admin.query("UPDATE public.supervisor_run_steps SET lease_until=now()-interval '1 second' WHERE run_id=$1 AND step_key='owner_turn'",[runId]);
   const expired=await dataQueryTools.query_data.execute(sql,durable);
   expect(expired.error).toBe("research_scope_denied");
   expect(expired.rows).toEqual([]);
  }finally{
   if(runId)await admin.query("DELETE FROM public.supervisor_runs WHERE id=$1",[runId]);
   await admin.query("DELETE FROM public.ai_messages WHERE id=$1",[message]);
   await admin.query("DELETE FROM public.employees WHERE id IN ($1,$2)",[employeeA,employeeB]);
  }
 });
 it("verifies actual named timecard observations from SQL source lineage",async()=>{
  if(!admin)throw Error("admin_missing");
  const employee=randomUUID(),card=randomUUID();
  await admin.query("INSERT INTO public.employees(id,business_id,display_name) VALUES($1,$2,'Sam')",[employee,ids.a]);
  await admin.query("INSERT INTO public.timecards(id,business_id,employee_id,clock_in,clock_out,source_type) VALUES($1,$2,$3,'2026-11-15T09:00:00Z','2026-11-15T15:00:00Z','connected_pos')",[card,ids.a,employee]);
  try{
   const result=await dataQueryTools.query_data.execute(input("SELECT timecard_id,employee_name,timezone,clock_in,clock_out,recorded_break_count FROM recorded_timecards"),scoped);
   expect(result.error).toBeUndefined();
   expect(result.rows).toHaveLength(1);
   expect(checkNumbers("Sam clocked in at 9:00 AM on November 15, 2026. Sam worked 6 hours.","",[result as unknown as AgentToolResult],"en")).toEqual([]);
   const other=await dataQueryTools.query_data.execute(input("SELECT count(*) AS n FROM recorded_timecards"),{...scoped,aggregateOnly:true});
   expect(other.error).toBe("unattended_aggregate_required");
  }finally{
   await admin.query("DELETE FROM public.timecards WHERE id=$1",[card]);
   await admin.query("DELETE FROM public.employees WHERE id=$1",[employee]);
  }
 });
 it("discovers newly admitted business configuration and source quality through the same SQL interface",async()=>{
  if(!admin)throw Error("admin_missing");
  await admin.query("INSERT INTO public.team_rules(business_id,meal_break_minutes) VALUES($1,35),($2,45) ON CONFLICT(business_id) DO UPDATE SET meal_break_minutes=excluded.meal_break_minutes",[ids.a,ids.b]);
  const context={asOf:"2026-11-24",timezone:"UTC",locale:"en",tools:{} as AgentToolContext["tools"],canonicalData:async()=>scoped} satisfies AgentToolContext;
  const d=await executeAgentTool("describe_data",{source:"research",search:"team_rules"},context);
  expect(d.missing).toEqual([]);
  expect(JSON.stringify(d)).toContain("meal_break_minutes");
  const rules=await dataQueryTools.query_data.execute(input("SELECT meal_break_minutes FROM team_rules"),scoped);
  expect(rules.error).toBeUndefined();
  expect(rules.rows).toEqual([{meal_break_minutes:35}]);
  const catalog=await executeAgentTool("describe_data",{source:"research",search:"toast_day_status"},context);
  expect(catalog.missing).toEqual([]);
  expect(JSON.stringify(catalog)).toContain("coverage_complete");
  expect(JSON.stringify(catalog)).not.toContain("orders_snapshot_sha256");
 });
 it("runs a real model-selected join with accurate café-isolated money",async()=>{
  const context={asOf:"2026-11-24",timezone:"UTC",locale:"en",
   tools:{} as AgentToolContext["tools"],canonicalData:async()=>scoped} satisfies AgentToolContext;
  const result=await executeAgentTool("query_data",input(
   "SELECT SUM(i.net_sales_cents) AS cents FROM u3_research.orders o "+
   "JOIN u3_research.order_lines i ON i.order_id=o.id"),context);
  expect(result.error).toBeUndefined();
  expect(result.missing).toEqual([]);
  expect(Number(((result.rows as Record<string,unknown>[])[0]).cents)).toBe(1100);
  expect(JSON.stringify(result)).not.toContain("4200");
 });
 it("executes SQL beyond the former character ceiling through the registered tool and real scoped DB",async()=>{
  const context={asOf:"2026-11-24",timezone:"UTC",locale:"en",
   tools:{} as AgentToolContext["tools"],canonicalData:async()=>scoped} satisfies AgentToolContext;
  const result=await executeAgentTool("query_data",input(
   "SELECT "+(" ".repeat(13000))+"SUM(net_sales_cents) AS amount FROM orders"),context);
  expect(result.error).toBeUndefined();
  expect(Number((result.rows as Record<string,unknown>[])[0].amount)).toBe(1100);
 });
 it("recovers a real PostgreSQL undefined column with a safe repair diagnostic and independent correct result",async()=>{
  const bad=await dataQueryTools.query_data.execute(input("SELECT missing_research_test_column FROM orders"),scoped);
  expect(bad.error).toBe("query_syntax_error");
  expect(bad).toMatchObject({diagnostic:{reason:"undefined_column",sqlstate:"42703"}});
  expect(JSON.stringify(bad)).not.toContain("missing_research_test_column");
  const corrected=await dataQueryTools.query_data.execute(input(
   "SELECT timezone('UTC',closed_at)::date AS observed_day,sum(net_sales_cents) AS amount FROM orders GROUP BY observed_day"),scoped);
  expect(corrected.error).toBeUndefined();
  expect(Number((corrected.rows[0] as Record<string,unknown>).amount)).toBe(1100);
 });
 it("denies model SQL mutation, forbidden relations and raw data exposure",async()=>{
  for(const sql of [
   "DELETE FROM u3_research.orders",
   "SELECT count(*) FROM public.orders",
   "SELECT * FROM u3_research.toast_records"
  ]){
   const result=await dataQueryTools.query_data.execute(input(sql),scoped);
   expect(result.error).toBe("invalid_query");
   expect(result.rows).toEqual([]);
  }
 });
 it("allows attested aggregate aliases but denies unreduced source rows off turn",async()=>{
  const offturn={...scoped,aggregateOnly:true};
  const result=await dataQueryTools.query_data.execute(input("SELECT COUNT(*) AS customer_count FROM orders"),offturn);
  expect(result.error).toBeUndefined();
  expect(result.rows).toEqual([{customer_count:"1"}]);
  const derived=await dataQueryTools.query_data.execute(input(
   "WITH summary AS (SELECT SUM(net_sales_cents) AS arbitrary_total FROM orders) SELECT arbitrary_total FROM summary ORDER BY arbitrary_total"),offturn);
  expect(derived.error).toBeUndefined();
  expect(derived.rows).toEqual([{arbitrary_total:"1100"}]);
  expect((derived as AgentToolResult).evidence).toMatchObject({column_units:{arbitrary_total:"cents"}});
  for(const sql of [
   "SELECT net_sales_cents FROM orders WHERE EXISTS(SELECT count(*) FROM orders)",
   "SELECT sum(net_sales_cents) OVER() AS total FROM orders"
  ]){
   const denied=await dataQueryTools.query_data.execute(input(sql),offturn);
   expect(denied.error).toBe("unattended_aggregate_required");
   expect(denied.rows).toEqual([]);
   const owner=await dataQueryTools.query_data.execute(input(sql),scoped);
   expect(owner.error).toBeUndefined();
   expect(owner.rows).toHaveLength(1);
  }
 });
 it("rejects private whole-row alias leakage through actual registered SQL tool",async()=>{
  const offturn={...scoped,aggregateOnly:true};
  for(const sql of [
   "SELECT MIN(o::text) AS result FROM u3_research.orders o",
   "SELECT MIN(orders_count::text) AS result FROM u3_research.orders AS orders_count",
   "WITH x AS (SELECT net_sales_cents FROM u3_research.orders) SELECT MIN(x::text) AS result FROM x"
  ]){
   const result=await dataQueryTools.query_data.execute(input(sql),offturn);
   expect(result.error,sql).toBe("invalid_query");
   expect(result.rows,sql).toEqual([]);
  }
  const legal=await dataQueryTools.query_data.execute(input(
   "SELECT SUM(o.net_sales_cents) AS result FROM u3_research.orders o"),offturn);
  expect(legal.error).toBeUndefined();
  expect(Number((legal.rows[0] as Record<string,unknown>).result)).toBe(1100);
 });
 it("supports safe relational wildcard reads and real conditional SQL arithmetic without a calculator detour",async()=>{
  const all=await dataQueryTools.query_data.execute(input("SELECT * FROM orders"),scoped);
  expect(all.error).toBeUndefined();
  expect(all.rows).toHaveLength(1);
  expect(all.rows[0]).toMatchObject({id:ids.orderA,net_sales_cents:"1100"});
  expect((all as unknown as AgentToolResult).evidence).toMatchObject({column_units:{net_sales_cents:"cents"},column_origins:{net_sales_cents:{relation:"orders",column:"net_sales_cents"}}});
  const result=await dataQueryTools.query_data.execute(input("SELECT SUM(CASE WHEN net_sales_cents>0 THEN net_sales_cents ELSE 0 END) AS positive, ROUND(AVG(net_sales_cents),0) AS average FROM orders"),scoped);
  expect(result.error).toBeUndefined();
  expect((result as unknown as AgentToolResult).evidence).toMatchObject({column_units:{positive:"cents",average:"cents"}});
  expect(checkNumbers("$11.00.","",[result as unknown as AgentToolResult],"en")).toEqual([]);
  const duplicate=await dataQueryTools.query_data.execute(input("SELECT o.*,l.* FROM orders o JOIN order_lines l ON o.id=l.order_id"),scoped);
  expect(duplicate.error).toBe("duplicate_result_columns");
  expect(duplicate.rows).toEqual([]);
 });
 it("never accepts a model-chosen numeric SQL label as verified money",async()=>{
  const result=await dataQueryTools.query_data.execute(input(
   'SELECT 99999 AS "fakeCents" FROM u3_research.orders'),scoped);
  expect(result.error).toBeUndefined();
  expect(result.missing).toEqual([]);
  expect(result.rows).toHaveLength(1);
  expect(compactEvidence([result as unknown as AgentToolResult]).flatMap(x=>x.values)).toEqual([]);
  expect(checkNumbers("$999.99.","",[result as unknown as AgentToolResult],"en"))
   .not.toEqual([]);
 });
 it("refuses a foreign owner's signed ticket before any data query",async()=>{
  const other={...scoped,ownerUserId:ids.ob};
  const result=await dataQueryTools.query_data.execute(input(
   "SELECT COUNT(*) AS n FROM u3_research.orders"),other);
  expect(result.error).toBe("research_scope_denied");
  expect(result.rows).toEqual([]);
 });
 it("uses canonical customer history and the unfiltered denominator through general SQL",async()=>{
  if(!admin)throw Error("sandbox unavailable");
  const date="2026-10-26",restA=randomUUID(),restB=randomUUID(),customer=randomUUID(),product=randomUUID();
  const payload=(amount:number)=>({guid:randomUUID(),checks:[{guid:randomUUID(),amount,
   customer:{guid:customer,firstName:"Synthetic"},payments:[{guid:randomUUID(),type:"CASH",amount}],
   selections:[{guid:randomUUID(),item:{guid:product},quantity:2,price:amount}]}]});
  await admin.query("INSERT INTO public.toast_raw_records(business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key) VALUES ($1,$2,'order',$3,$4,$5,$6),($7,$8,'order',$9,$10,$11,$12)",
   [ids.a,restA,date,JSON.stringify(payload(12)),randomBytes(32).toString("hex"),"live:u3-customer-a",
    ids.b,restB,date,JSON.stringify(payload(47)),randomBytes(32).toString("hex"),"live:u3-customer-b"]);
  try{
   const oracle=await admin.query("SELECT COUNT(*) AS n, SUM(net_sales_cents) AS total_cents FROM public.customer_visits_for($1,$2,$2)",[ids.a,date]);
   expect(Number(oracle.rows[0].n)).toBeGreaterThan(0);
   const range={date_from:date,date_to:date};
   const result=await dataQueryTools.query_data.execute({...input("SELECT COUNT(*) AS n,SUM(net_sales_cents) AS total_cents FROM customer_visits"),...range},scoped);
   expect(result.error).toBeUndefined();
   expect(result.rows).toEqual(oracle.rows);
   const denominator=(await admin.query("SELECT public.customer_query_coverage($1,$2,$2) AS coverage",[ids.a,date])).rows[0].coverage;
   expect(result).toMatchObject({customerEvidence:true,customerCoverage:denominator,period:{from:date,to:date}});
   // Customer rows and their independent denominator must survive a changed source and cache miss.
   const detail={...input("SELECT business_date,net_sales_cents,1 AS n FROM customer_visits UNION ALL SELECT business_date,net_sales_cents,2 AS n FROM customer_visits UNION ALL SELECT business_date,net_sales_cents,3 AS n FROM customer_visits ORDER BY business_date,n"),...range,limit:1};
   const first=await dataQueryTools.query_data.execute(detail,scoped);
   expect(first).toMatchObject({page_complete:false,page_retrieval:"executed_query",customerCoverage:denominator});
   const token=(first as {next_cursor:string}).next_cursor;
   expect(token).toEqual(expect.any(String));
   const worker=vi.spyOn(researchPageCache,"read").mockReturnValue(null);
   try{
    await admin.query("INSERT INTO public.toast_raw_records(business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key) VALUES ($1,$2,'order',$3,$4,$5,$6)",
     [ids.a,restA,date,JSON.stringify(payload(95)),randomBytes(32).toString("hex"),"live:u3-customer-new"]);
    const next=await dataQueryTools.query_data.execute({...detail,cursor:token},scoped);
    expect(next).toMatchObject({page_retrieval:"retained_result",customerCoverage:denominator,rows:[{business_date:expect.anything(),net_sales_cents:expect.anything(),n:2}]});
   }finally{
    worker.mockRestore();
    await admin.query("DELETE FROM public.toast_raw_records WHERE business_id=$1 AND capture_key='live:u3-customer-new'",[ids.a]);
   }
   const filtered=await dataQueryTools.query_data.execute({...input("SELECT COUNT(*) AS n FROM customer_visits WHERE net_sales_cents=0"),...range},scoped);
   expect(filtered.rows).toEqual([{n:"0"}]);
   expect(filtered).toMatchObject({customerCoverage:denominator});
   const offturn=await dataQueryTools.query_data.execute({...input("SELECT COUNT(*) AS n,SUM(net_sales_cents) AS total_cents FROM customer_visits"),...range},{...scoped,aggregateOnly:true});
   expect(offturn.rows).toEqual(oracle.rows);
   expect(offturn).toMatchObject({customerCoverage:denominator,aggregateOnly:true});
   const denied=await dataQueryTools.query_data.execute({...input("SELECT MAX(identity_ref) AS alias FROM customer_visits"),...range},{...scoped,aggregateOnly:true});
   expect(denied.error).toBeDefined();
   const items=await dataQueryTools.query_data.execute({...input("SELECT COUNT(*) AS n FROM customer_products"),...range},scoped);
   const productOracle=await admin.query("SELECT COUNT(*) AS n FROM public.customer_products_for($1,$2,$2)",[ids.a,date]);
   expect(items.rows).toEqual(productOracle.rows);
   expect(Number(productOracle.rows[0].n)).toBeGreaterThan(0);
  }finally{
   await admin.query("DELETE FROM public.toast_raw_records WHERE business_id IN ($1,$2) AND capture_key IN ('live:u3-customer-a','live:u3-customer-b')",[ids.a,ids.b]);
  }
 });
 it("generates cross-café join and fanout fixtures, checks independent money oracle, and records matched costs",async()=>{
  if(!admin)throw Error("admin_missing");
  // Reproducible metamorphic data; no owner-question string drives data routing.
  let seed=41909;
  const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
  const insertedOrders:string[]=[],insertedLines:string[]=[];
  const cases:{businessId:string;amount:number;lines:number[]}[]=[];
  try{
   for(let i=0;i<24;i++){
    const id=randomUUID(),cafe=i%2===0?ids.a:ids.b,amount=101+rand()%4400;
    const split=i%3===0?[Math.floor(amount/2),amount-Math.floor(amount/2)]:[amount];
    insertedOrders.push(id);
    cases.push({businessId:cafe,amount,lines:split});
    await admin.query("INSERT INTO public.orders(id,business_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents) VALUES($1,$2,$3,now(),current_date,$4,$4)",
     [id,cafe,"u3-seed-"+i,amount]);
    for(const [part,lineAmount] of split.entries()){
     const lineId=randomUUID();insertedLines.push(lineId);
     await admin.query("INSERT INTO public.order_lines(id,order_id,name,quantity,net_sales_cents) VALUES($1,$2,$3,1,$4)",
      [lineId,id,"Generated line "+part,lineAmount]);
    }
   }
   const oracle=await admin.query(
    "SELECT COALESCE(SUM(net_sales_cents),0)::text AS cents FROM public.orders WHERE business_id=$1",
    [ids.a]);
   const expected=Number(oracle.rows[0].cents);
   const independentlyComputed=1100+cases.filter(c=>c.businessId===ids.a).reduce((sum,c)=>sum+c.amount,0);
   expect(expected).toBe(independentlyComputed);
   const sqls=[
    "SELECT SUM(net_sales_cents) AS cents FROM u3_research.orders",
    "SELECT SUM(p.cents) AS cents FROM u3_research.orders o JOIN (SELECT order_id,SUM(net_sales_cents) AS cents FROM u3_research.order_lines GROUP BY order_id) p ON p.order_id=o.id",
    "WITH per_order AS (SELECT order_id,SUM(net_sales_cents) AS cents FROM u3_research.order_lines GROUP BY order_id) SELECT SUM(p.cents) AS cents FROM u3_research.orders o JOIN per_order p ON p.order_id=o.id"
   ];
   for(const sql of sqls){
    const result=await dataQueryTools.query_data.execute(input(sql),scoped);
    expect(result.error,sql).toBeUndefined();
    expect(result.truncated,sql).toBe(false);
    expect(Number((result.rows[0] as Record<string,unknown>).cents),sql).toBe(expected);
   }
   const baselineMs:number[]=[],researchMs:number[]=[];
   const research=()=>dataQueryTools.query_data.execute(input(sqls[0]),scoped);
   for(let i=0;i<10;i++){
    let started=performance.now();
    const baseline=await admin.query(
     "SELECT COALESCE(SUM(net_sales_cents),0)::text AS cents FROM public.orders WHERE business_id=$1",
     [ids.a]);
    baselineMs.push(performance.now()-started);
    expect(Number(baseline.rows[0].cents)).toBe(expected);
    started=performance.now();
    const actual=await research();
    researchMs.push(performance.now()-started);
    expect(actual.error).toBeUndefined();
    expect(Number((actual.rows[0] as Record<string,unknown>).cents)).toBe(expected);
   }
   const quantile=(values:number[],q:number)=>{
    const sorted=[...values].sort((a,b)=>a-b);
    return Number(sorted[Math.ceil((sorted.length-1)*q)].toFixed(2));
   };
   console.log("U3_NO_PROVIDER_MATCHED_MEASUREMENT",JSON.stringify({
    fixtureSeed:41909,generatedOrders:cases.length,generatedLines:cases.reduce((s,c)=>s+c.lines.length,0),
    deterministicVariations:sqls.length,independentOracleCents:expected,modelCalls:0,
    baseline:"scoped direct source SQL; NOT legacy ai_query_view",
    legacyBaseline:{p50Ms:quantile(baselineMs,.5),p95Ms:quantile(baselineMs,.95)},
    researchTool:{p50Ms:quantile(researchMs,.5),p95Ms:quantile(researchMs,.95)},
    caveat:"Synthetic local fixture only; not a live production/paid-model performance comparison"
   }));
  }finally{
   await admin.query("DELETE FROM public.order_lines WHERE id=ANY($1::uuid[])",[insertedLines]).catch(()=>{});
   await admin.query("DELETE FROM public.orders WHERE id=ANY($1::uuid[])",[insertedOrders]).catch(()=>{});
  }
 });
 it("measures concurrent registered research over multi-month realistic volume with two independent cafe oracles",async()=>{
  if(!admin)throw Error("admin_missing");
  // Approximately the 90-day reference cafe volume per tenant, not a
  // production query, total-row policy or model/provider cost benchmark.
  const fixtures=24000,perCafe=fixtures/2,days=90;
  const prefix="u3-concurrent-";
  const foreign={...scoped,businessId:ids.b,ownerUserId:ids.ob,threadId:ids.tb};
  try{
   await admin.query("INSERT INTO public.orders(id,business_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents) "+
    "SELECT gen_random_uuid(),CASE WHEN i%2=0 THEN $1::uuid ELSE $2::uuid END,$3||i::text,now(),"+
    "date '2025-01-01'+(((i-1)/2)%$5::int),100+i,100+i FROM generate_series(1,$4::int) i",[ids.a,ids.b,prefix,fixtures,days]);
   const oracle=await admin.query("SELECT business_id,to_char(business_date,'YYYY-MM') AS month,COUNT(*)::text AS n,SUM(net_sales_cents)::text AS cents "+
    "FROM public.orders WHERE business_id IN ($1,$2) AND pos_order_id LIKE $3 GROUP BY business_id,month ORDER BY business_id,month",[ids.a,ids.b,prefix+"%"]);
   const expected=new Map<string,Array<{month:string;n:string;cents:string;sales_rank:string}>>();
   for(const cafe of [ids.a,ids.b]){
    const months=oracle.rows.filter(row=>row.business_id===cafe).map(row=>({month:String(row.month),n:String(row.n),cents:String(row.cents)}));
    expect(months.length).toBeGreaterThan(1);
    expect(months.reduce((sum,row)=>sum+Number(row.n),0)).toBe(perCafe);
    expected.set(cafe,months.map(row=>({...row,sales_rank:String(1+months.filter(other=>Number(other.cents)>Number(row.cents)).length)})));
   }
   const sql="WITH monthly AS (SELECT to_char(business_date,'YYYY-MM') AS month,COUNT(*) AS n,SUM(net_sales_cents) AS cents "+
    "FROM orders WHERE pos_order_id LIKE $1 GROUP BY 1) SELECT month,n,cents,RANK() OVER (ORDER BY cents DESC) AS sales_rank FROM monthly ORDER BY month";
   // Both owners use the actual registered research entry point and distinct
   // signed tickets on the same bounded shared research connection pool.
   const timings:number[]=[];
   for(let round=0;round<3;round++){
    await Promise.all([scoped,foreign,scoped,foreign].map(async(scope)=>{
     const context:AgentToolContext={asOf:"2026-11-24",timezone:"UTC",locale:"en",
      tools:{} as AgentToolContext["tools"],canonicalData:async()=>scope};
     const started=performance.now();
     const r=await executeAgentTool("query_data",{...input(sql),parameters:[prefix+"%"],limit:null},context);
     timings.push(performance.now()-started);
     expect(r.error).toBeUndefined();
     expect(r.rows).toEqual(expected.get(scope.businessId));
     expect(r).toMatchObject({page_complete:true,truncated:false});
    }));
   }
   timings.sort((a,b)=>a-b);
   console.log("U3_CONCURRENT_REGISTERED_MEASUREMENT",JSON.stringify({generatedOrders:fixtures,ordersPerCafe:perCafe,days,
    distinctCafes:2,parallelRequests:4,requests:timings.length,modelCalls:0,
    queryShape:"monthly CTE aggregation and ranking window",
    p50Ms:Number(timings[Math.ceil(timings.length*.5)-1].toFixed(2)),
    p95Ms:Number(timings[Math.ceil(timings.length*.95)-1].toFixed(2)),
    caveat:"Disposable normalized orders and actual research pool; not production or provider cost"}));
  }finally{
   await admin.query("DELETE FROM public.orders WHERE business_id IN ($1,$2) AND pos_order_id LIKE $3",[ids.a,ids.b,prefix+"%"]).catch(()=>{});
  }
 },60000);
 it("traverses the actual invoker-RLS canonical reader beyond its old row and byte preview caps",async()=>{
  if(!admin)throw Error("admin_missing");
  const db=admin,prefix="u3-legacy-pages-",from="2025-01-01",to="2025-04-01";
  const rpc=async(name:string,p:Record<string,unknown>)=>{
   if(name!=="ai_query_view")return {data:null,error:{message:"unexpected RPC"}};
   await db.query("BEGIN");
   try{
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",[ids.oa]);
    const r=await db.query("SELECT public.ai_query_view($1::uuid,$2::text,$3::text[],$4::jsonb,$5::text[],$6::jsonb,$7::date,$8::date,$9::jsonb,$10::bigint,$11::bigint,$12::integer) AS result",
     [p.p_business_id,p.p_view,p.p_columns,JSON.stringify(p.p_filters),p.p_group_by,JSON.stringify(p.p_metrics),p.p_date_from,p.p_date_to,
      p.p_order_by===null?null:JSON.stringify(p.p_order_by),p.p_limit,p.p_page_offset,p.p_page_bytes]);
    await db.query("COMMIT");
    return {data:r.rows[0].result,error:null};
   }catch(e){await db.query("ROLLBACK");return {data:null,error:e};}
  };
  const context:AgentToolContext={asOf:"2026-11-24",timezone:"UTC",locale:"en",
   tools:{} as AgentToolContext["tools"],canonicalData:async()=>({...scoped,db:{rpc} as never})};
  const selector={view:"cv_orders",sql:null,parameters:null,columns:["source_ref","business_date","net_sales_cents"],
   filters:null,group_by:null,metrics:null,date_from:from,date_to:to,order_by:{column:"source_ref",direction:"asc"},limit:null};
  try{
   await db.query("INSERT INTO public.orders(id,business_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents) "+
    "SELECT gen_random_uuid(),CASE WHEN i<=160 THEN $1::uuid ELSE $2::uuid END,$3||i::text,now(),date '2025-01-01'+(i%90),100+i,100+i FROM generate_series(1,163) i",[ids.a,ids.b,prefix]);
   const oracle=await db.query("SELECT to_jsonb(q) AS row FROM (SELECT source_ref,business_date,net_sales_cents FROM public.cv_orders WHERE business_id=$1 AND business_date BETWEEN $2 AND $3 ORDER BY source_ref) q",[ids.a,from,to]);
   expect(oracle.rows).toHaveLength(160);
   const full=await executeAgentTool("query_data",selector,context);
   expect(full.error).toBeUndefined();
   expect(full.rows).toEqual(oracle.rows.map(r=>r.row));
   expect(Buffer.byteLength(JSON.stringify(full.rows),"utf8")).toBeGreaterThan(6000);
   expect(full).toMatchObject({page_complete:true,total_rows:160,next_cursor:null});
   const narrow={...context,researchPageBytes:()=>2500};
   let cursor:string|null=null;const seen:unknown[]=[];let pages=0;
   do{
    const r=await executeAgentTool("query_data",{...selector,cursor},narrow);
    expect(r.error).toBeUndefined();
    expect(r.page_consistency).toBe("verified_same_result");
    expect(Array.isArray(r.rows)).toBe(true);
    seen.push(...r.rows as unknown[]);
    cursor=(r.next_cursor as string|null)??null;
    expect(r.page_complete).toBe(cursor===null);
    expect(++pages).toBeLessThan(40);
   }while(cursor!==null);
   expect(pages).toBeGreaterThan(1);
   expect(seen).toEqual(oracle.rows.map(r=>r.row));
   const first=await executeAgentTool("query_data",selector,narrow);
   expect(first.next_cursor).toBeTruthy();
   await db.query("UPDATE public.orders SET net_sales_cents=999 WHERE business_id=$1 AND pos_order_id=$2",[ids.a,prefix+"1"]);
   const stale=await executeAgentTool("query_data",{...selector,cursor:first.next_cursor},narrow);
   expect(stale).toMatchObject({error:"research_snapshot_changed",rows:[]});
   const foreign=await executeAgentTool("query_data",selector,{...context,canonicalData:async()=>({...scoped,businessId:ids.b,db:{rpc} as never})});
   expect(foreign.rows).toEqual([]);
  }finally{
   await db.query("DELETE FROM public.orders WHERE business_id IN ($1,$2) AND pos_order_id LIKE $3",[ids.a,ids.b,prefix+"%"]).catch(()=>{});
  }
 });
 it("uses historical ingredient price revisions and exact source units without a capped ingredient reader",async()=>{
  if(!admin)throw Error("admin_missing");
  const local=randomUUID(),unknown=randomUUID(),foreign=randomUUID();
  try{
   await admin.query("INSERT INTO public.ingredients(id,business_id,name,base_unit) VALUES($1,$2,'Scoped price history','g'),($3,$2,'Unpriced ingredient','g'),($4,$5,'Foreign ingredient','g')",[local,ids.a,unknown,foreign,ids.b]);
   await admin.query("INSERT INTO public.ingredient_prices(ingredient_id,effective_from,cost_per_base_unit_micros,source,recorded_at) VALUES "+
    "($1,'2026-01-01',1000000,'manual','2026-01-01T00:00:00Z'),($1,'2026-05-01',2000000,'manual','2026-05-01T00:00:00Z'),"+
    "($1,'2026-05-01',3000000,'manual','2026-05-01T01:00:00Z'),($1,'2026-12-01',9000000,'manual','2026-12-01T00:00:00Z'),"+
    "($2,'2026-01-01',99000000,'manual','2026-01-01T00:00:00Z')",[local,foreign]);
   const date="2026-06-01";
   const oracle=await admin.query("SELECT i.name,i.base_unit,p.cost_per_base_unit_micros,p.effective_from::text AS effective_from FROM public.ingredients i "+
    "LEFT JOIN LATERAL (SELECT cost_per_base_unit_micros,effective_from FROM public.ingredient_prices WHERE ingredient_id=i.id AND effective_from <= $2::date ORDER BY effective_from DESC,recorded_at DESC,id DESC LIMIT 1) p ON true "+
    "WHERE i.business_id=$1 ORDER BY i.name",[ids.a,date]);
   const sql="WITH prices AS (SELECT ingredient_id,cost_per_base_unit_micros,effective_from,ROW_NUMBER() OVER(PARTITION BY ingredient_id ORDER BY effective_from DESC,recorded_at DESC,id DESC) AS rn FROM ingredient_prices WHERE effective_from <= $1::date) "+
    "SELECT i.name,i.base_unit,p.cost_per_base_unit_micros,p.effective_from::text AS effective_from FROM ingredients i LEFT JOIN prices p ON p.ingredient_id=i.id AND p.rn=1 ORDER BY i.name";
   const r=await dataQueryTools.query_data.execute({...input(sql),parameters:[date],limit:null},scoped);
   expect(r.error).toBeUndefined();
   expect(r.rows).toEqual(oracle.rows);
   expect(r.rows).toHaveLength(2);
   expect(r.rows[0]).toMatchObject({name:"Scoped price history",cost_per_base_unit_micros:"3000000",effective_from:"2026-05-01"});
   expect(r.rows[1]).toMatchObject({name:"Unpriced ingredient",cost_per_base_unit_micros:null,effective_from:null});
   expect((r as unknown as AgentToolResult).evidence).toMatchObject({column_units:{cost_per_base_unit_micros:"microcents"}});
   expect(checkNumbers("The recorded ingredient price is $0.03 per gram.","",[r as unknown as AgentToolResult],"en")).toEqual([]);
  }finally{
   await admin.query("DELETE FROM public.ingredient_prices WHERE ingredient_id IN ($1,$2,$3)",[local,unknown,foreign]).catch(()=>{});
   await admin.query("DELETE FROM public.ingredients WHERE id IN ($1,$2,$3)",[local,unknown,foreign]).catch(()=>{});
  }
 });
 it("traverses every historical ordered SQL row across pages without any total cap",async()=>{
  if(!admin)throw Error("admin_missing");
  // Historical source dates and result size exceed the original ceilings.
  try{
   await admin.query(
    "INSERT INTO public.orders(id,business_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents) "+
    "SELECT gen_random_uuid(),$1,'u3-cursor-'||i::text,now(),"+
      "date '2026-01-01'+(i-1),100+i,100+i FROM generate_series(1,137) AS i",[ids.a]);
   const sql="SELECT id,business_date,net_sales_cents FROM u3_research.orders ORDER BY business_date,id";
   // A compact result exceeding 100 rows must complete without extra model calls.
   const compact=await dataQueryTools.query_data.execute({
    ...input("SELECT net_sales_cents FROM u3_research.orders WHERE net_sales_cents < $1 ORDER BY net_sales_cents"),
    parameters:[4200],limit:null,date_from:"2025-01-01",date_to:"2026-11-23"
   },scoped);
   expect(compact.error).toBeUndefined();
   expect(compact.rows).toHaveLength(138);
   expect(compact.truncated).toBe(false);
   expect(compact).toMatchObject({page_complete:true,next_cursor:null});
   // A wide result must fit when measured context allows it, regardless of
   // the former 24 KiB ceiling. Smaller request capacity uses the same cursor.
   const wideSql="SELECT id,$1::text AS note FROM u3_research.orders ORDER BY id";
   const wideInput={...input(wideSql),parameters:["x".repeat(300)],limit:null};
   const wide=await dataQueryTools.query_data.execute(wideInput,scoped);
   expect(wide.error).toBeUndefined();
   expect(wide.rows).toHaveLength(138);
   expect(Buffer.byteLength(JSON.stringify(wide.rows),"utf8")).toBeGreaterThan(24576);
   expect(wide).toMatchObject({page_complete:true});
   const narrow=await dataQueryTools.query_data.execute(wideInput,{...scoped,resultBudgetBytes:3000});
   expect(narrow.error).toBeUndefined();
   expect(narrow.rows.length).toBeGreaterThan(0);
   expect(narrow.rows.length).toBeLessThan(138);
   expect(narrow).toMatchObject({page_complete:false,total_rows:138});
   const remainder=await dataQueryTools.query_data.execute({...wideInput,cursor:(narrow as {next_cursor:string}).next_cursor},scoped);
   expect(remainder.error).toBeUndefined();
   expect([...narrow.rows,...remainder.rows]).toEqual(wide.rows);
   expect(remainder).toMatchObject({page_complete:true});
   const noCapacity=await dataQueryTools.query_data.execute(wideInput,{...scoped,resultBudgetBytes:0});
   expect(noCapacity).toMatchObject({error:"research_context_exhausted",rows:[]});
   const longBind=await dataQueryTools.query_data.execute({...input("SELECT $1::text AS note FROM u3_research.orders LIMIT 1"),parameters:["y".repeat(800)]},scoped);
   expect(longBind.rows).toEqual([{note:"y".repeat(800)}]);
   const manyBind=await dataQueryTools.query_data.execute({...input("SELECT COUNT(*) AS n FROM u3_research.orders WHERE net_sales_cents IN ("+Array.from({length:64},(_,i)=>"$"+(i+1)).join(",")+")"),parameters:Array.from({length:64},(_,i)=>101+i)},scoped);
   expect(manyBind.error).toBeUndefined();
   expect(Number((manyBind.rows[0] as Record<string,unknown>).n)).toBe(64);
   const explicit=await dataQueryTools.query_data.execute({
    ...input("SELECT net_sales_cents FROM u3_research.orders ORDER BY net_sales_cents"),limit:200
   },scoped);
   expect(explicit.error).toBeUndefined();
   expect(explicit.rows).toHaveLength(138);
   expect(explicit).toMatchObject({page_complete:true,next_cursor:null});
   let cursor:string|null=null,pages=0,complete=false;
   const seen:string[]=[];
   do{
    const result=await dataQueryTools.query_data.execute({
     ...input(sql),limit:50,date_from:"2025-01-01",
     date_to:"2026-11-23",cursor
    },scoped);
    expect(result.error).toBeUndefined();
    const page=result as typeof result&{
     next_cursor?:string|null;page_complete?:boolean;
     page_consistency?:string
    };
    expect(page.page_consistency).toBe("verified_same_result");
    for(const item of result.rows){
     const row=item as Record<string,unknown>;
     seen.push(String(row.id));
     expect(Number(row.net_sales_cents)).toBeLessThan(4200);
    }
    pages++;
    expect(pages).toBeLessThan(20);
    cursor=page.next_cursor??null;
    complete=page.page_complete===true;
    expect(complete).toBe(cursor===null);
    expect(result.truncated).toBe(!complete);
   }while(cursor!==null);
   const oracle=await admin.query("SELECT id::text FROM public.orders WHERE business_id=$1 ORDER BY business_date,id",[ids.a]);
   expect(pages).toBeGreaterThanOrEqual(3);
   expect(seen).toEqual(oracle.rows.map(v=>v.id));
   expect(new Set(seen).size).toBe(138);
   // Unordered queries may be paged if the actual ordered result remains
   // identical; no invented ordering is imposed on the model's SELECT.
   const unordered=await dataQueryTools.query_data.execute({
    ...input("SELECT id FROM u3_research.orders"),limit:50
   },scoped);
   expect(unordered.error).toBeUndefined();
   expect(unordered).toMatchObject({page_complete:false,page_consistency:"verified_same_result"});
   // Mutate a row OUTSIDE the first page, leaving the prefix unchanged.
   // A prefix-only digest would miss this. No mixed snapshot rows may escape.
   const first=await dataQueryTools.query_data.execute({...input(sql),limit:50},scoped);
   const token=(first as {next_cursor?:string}).next_cursor;
   expect(token).toEqual(expect.any(String));
   await admin.query("UPDATE public.orders SET net_sales_cents=net_sales_cents+1 WHERE business_id=$1 AND pos_order_id='u3-cursor-137'",[ids.a]);
   const changed=await dataQueryTools.query_data.execute({...input(sql),limit:50,cursor:token},scoped);
   // A retained observation is immutable even when the underlying source
   // changes; on cache miss the original digest must instead reject replay.
   if(changed.error)expect(changed).toMatchObject({error:"research_snapshot_changed",rows:[],page_complete:false});
   else{
    expect(changed).toMatchObject({page_retrieval:"retained_result",page_consistency:"verified_same_result",page_complete:false});
    expect((changed.rows as Array<{id:string}>).map(v=>v.id)).toEqual(oracle.rows.slice(50,100).map(v=>v.id));
   }
   const restart=await dataQueryTools.query_data.execute({...input(sql),limit:50},scoped);
   expect(restart.error).toBeUndefined();
  }finally{
   await admin.query("DELETE FROM public.orders WHERE business_id=$1 AND pos_order_id LIKE 'u3-cursor-%'",[ids.a]).catch(()=>{});
  }
 });
 it("only retains detail when it needs continuation and preserves the original SQL result across workers",async()=>{
  if(!admin)throw Error("admin_missing");
  const worker=vi.spyOn(researchPageCache,"read").mockReturnValue(null);
  const collect=vi.spyOn(ResearchPageCollector.prototype,"add");
  const snapshots=async()=>Number((await admin!.query(
   "SELECT count(*) FROM u3_research_private.query_snapshot_chunks WHERE thread_id=$1",[ids.ta])).rows[0].count);
  const prefix="u3-durable-snapshot-";
  try{
   await admin.query("INSERT INTO public.orders(id,business_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents) "+
    "SELECT gen_random_uuid(),$1,$2||i::text,now(),current_date,i,i FROM generate_series(1,140) i",[ids.a,prefix]);
   const before=await snapshots();
   const sql="SELECT id,net_sales_cents,$1::text AS note FROM orders";
   const complete=await dataQueryTools.query_data.execute({
    ...input(sql),parameters:["x".repeat(600)],limit:null,
   },scoped);
   expect(complete).toMatchObject({page_complete:true,next_cursor:null});
   expect(complete.rows).toHaveLength(141);
   expect(collect).not.toHaveBeenCalled();
   expect(await snapshots()).toBe(before);
   const note="x".repeat(2200);
   const detail={...input(sql),parameters:[note],limit:null};
   const first=await dataQueryTools.query_data.execute(detail,scoped);
   expect(first).toMatchObject({page_complete:false,page_retrieval:"executed_query",total_rows:141});
   let cursor=(first as {next_cursor?:string|null}).next_cursor;
   expect(cursor).toEqual(expect.any(String));
   expect(await snapshots()).toBeGreaterThanOrEqual(before+2);
   await admin.query("UPDATE public.orders SET net_sales_cents=99999 WHERE business_id=$1 AND pos_order_id LIKE $2",
    [ids.a,prefix+"%"]);
   const observed=[...first.rows];
   for(let pages=1;cursor;pages++){
    expect(pages).toBeLessThan(5);
    const result=await dataQueryTools.query_data.execute({...detail,cursor},scoped);
    expect(result).toMatchObject({page_retrieval:"retained_result",total_rows:141});
    observed.push(...result.rows);
    cursor=(result as {next_cursor?:string|null}).next_cursor;
    expect(result).toMatchObject({page_complete:cursor===null});
   }
   const key=(row:unknown)=>(row as {id:string}).id;
   const byId=(a:unknown,b:unknown)=>key(a).localeCompare(key(b));
   const expected=complete.rows.map(row=>({...row as object,note})).sort(byId);
   expect(observed.sort(byId)).toEqual(expected);
  }finally{
   worker.mockRestore();
   collect.mockRestore();
   await admin.query("DELETE FROM public.orders WHERE business_id=$1 AND pos_order_id LIKE $2",[ids.a,prefix+"%"]);
  }
 });
 it("queries saved provisional hourly sales with the same closeout rules and café isolation as the app",async()=>{
  if(!admin)throw Error("admin_missing");
  const date="2026-10-17";
  try{
   await admin.query("INSERT INTO public.toast_today_live(business_id,business_date,read_at,net_sales_cents,orders,reading) "+
    "VALUES($1,$3,now(),2450,2,$4::jsonb),($2,$3,now(),9999,7,$5::jsonb)",[ids.a,ids.b,date,
     JSON.stringify({hourlySales:[{hourLocal:9,netSalesCents:2450,ordersCount:2}],locationsFailed:0,truncated:false}),
     JSON.stringify({hourlySales:[{hourLocal:9,netSalesCents:9999,ordersCount:7}]})]);
   const selection={...input("SELECT hour_local,net_sales_cents,orders_count,status,locations_failed,truncated "+
    "FROM provisional_hourly_sales WHERE business_date=$1::date"),parameters:[date],limit:null};
   const actual=await dataQueryTools.query_data.execute(selection,scoped);
   expect(actual.error).toBeUndefined();
   expect(actual.rows).toEqual([{hour_local:9,net_sales_cents:"2450",orders_count:2,
    status:"provisional",locations_failed:"0",truncated:false}]);
   await admin.query("INSERT INTO public.hourly_sales_rollup(business_id,business_date,hour_local,net_sales_cents,orders_count) "+
    "VALUES($1,$2,9,2500,3)",[ids.a,date]);
   const closed=await dataQueryTools.query_data.execute(selection,scoped);
   expect(closed.error).toBeUndefined();
   expect(closed).toMatchObject({rows:[],page_complete:true});
  }finally{
   await admin.query("DELETE FROM public.hourly_sales_rollup WHERE business_id=$1 AND business_date=$2",[ids.a,date]);
   await admin.query("DELETE FROM public.toast_today_live WHERE business_id IN ($1,$2)",[ids.a,ids.b]);
  }
 });
 it("returns nonempty multi-year Toast change evidence, not a silent date-window rejection",async()=>{
  if(!admin)throw Error("admin_missing");
  const old=randomUUID(),recent=randomUUID(),foreign=randomUUID();
  try{
   await admin.query("INSERT INTO public.toast_raw_changes(business_id,restaurant_guid,entity,entity_guid,business_date,changes) VALUES "+
    "($1,NULL,'employee',$3,'2023-02-01',$6::jsonb),($1,NULL,'employee',$4,'2026-11-01',$7::jsonb),($2,NULL,'employee',$5,'2025-01-01',$8::jsonb)",
    [ids.a,ids.b,old,recent,foreign,
     JSON.stringify([{path:".properties.verified.quantity",before:1,after:3}]),
     JSON.stringify([{path:".properties.verified.quantity",before:3,after:5}]),
     JSON.stringify([{path:".properties.verified.quantity",before:5,after:9}])]);
   const result=await dataQueryTools.query_data.execute({
    ...input("SELECT business_date::text AS business_date,after_scalar FROM u3_research.toast_changes ORDER BY business_date"),
    date_from:"2023-01-01",date_to:"2026-11-23"
   },scoped);
   expect(result.error).toBeUndefined();
   expect(result.rows).toEqual([{business_date:"2023-02-01",after_scalar:"3"},{business_date:"2026-11-01",after_scalar:"5"}]);
   expect(result).toMatchObject({page_complete:true,truncated:false});
   const independent=await admin.query("SELECT business_date::text AS business_date,changes->0->>'after' AS after_scalar FROM public.toast_raw_changes WHERE business_id=$1 AND entity_guid IN ($2,$3) ORDER BY business_date",[ids.a,old,recent]);
   expect(result.rows).toEqual(independent.rows);
  }finally{
   await admin.query("DELETE FROM public.toast_raw_changes WHERE entity_guid IN ($1,$2,$3)",[old,recent,foreign]);
  }
 });
 it("answers configured hours and employee-attributed sales through ordinary SQL after model-facing report retirement",async()=>{
  if(!admin)throw Error("admin_missing");
  const locationA=randomUUID(),locationB=randomUUID(),employeeA=randomUUID(),employeeB=randomUUID();
  try{
   await admin.query("INSERT INTO public.locations(id,business_id,name,timezone,open_hours) VALUES ($1,$2,'Research location A','UTC',$5::jsonb),($3,$4,'Research location B','UTC',$6::jsonb)",[locationA,ids.a,locationB,ids.b,JSON.stringify({mon:[["07:00","16:00"]],tue:[]}),JSON.stringify({mon:[["09:00","22:00"]]})]);
   await admin.query("INSERT INTO public.employees(id,business_id,display_name) VALUES ($1,$2,'Research employee A'),($3,$4,'Research employee B')",[employeeA,ids.a,employeeB,ids.b]);
   await admin.query("INSERT INTO public.employee_sales_rollup(business_id,business_date,employee_id,net_sales_cents,orders_count) VALUES ($1,'2026-11-01',$3,3500,3),($1,'2026-11-02',$3,700,1),($2,'2026-11-01',$4,9900,9)",[ids.a,ids.b,employeeA,employeeB]);
   const hours=await dataQueryTools.query_data.execute({...input("SELECT location_id,weekday,hours_status,open_time,close_time FROM opening_hours ORDER BY weekday"),limit:null},scoped);
   expect(hours.error).toBeUndefined();
   const rows=hours.rows as Array<Record<string,unknown>>;
   expect(rows).toHaveLength(7);
   expect(rows.find(r=>r.weekday==="mon")).toMatchObject({location_id:locationA,hours_status:"open",open_time:"07:00",close_time:"16:00"});
   expect(rows.find(r=>r.weekday==="tue")).toMatchObject({hours_status:"closed",open_time:null});
   expect(rows.find(r=>r.weekday==="wed")).toMatchObject({hours_status:"unknown",open_time:null});
   expect(checkNumbers("On Monday the café opens at 7:00 AM and closes at 4:00 PM.","",[hours as unknown as AgentToolResult],"en")).toEqual([]);
   expect(checkNumbers("On Monday the café opens at 9:00 AM.","",[hours as unknown as AgentToolResult],"en").length).toBeGreaterThan(0);
   const fabricated=await dataQueryTools.query_data.execute(input("SELECT location_id,weekday,hours_status,'09:00'::text AS open_time FROM opening_hours WHERE weekday='mon'"),scoped);
   expect(checkNumbers("On Monday the café opens at 9:00 AM.","",[fabricated as unknown as AgentToolResult],"en").length).toBeGreaterThan(0);
   const sales=await dataQueryTools.query_data.execute(input("SELECT e.display_name,SUM(s.net_sales_cents) AS attributed_cents,SUM(s.orders_count) AS attributed_orders FROM employee_sales_rollup s JOIN employees e ON e.id=s.employee_id WHERE s.business_date BETWEEN '2026-11-01' AND '2026-11-02' GROUP BY e.display_name"),scoped);
   expect(sales.error).toBeUndefined();
   expect(sales.rows).toEqual([{display_name:"Research employee A",attributed_cents:"4200",attributed_orders:"4"}]);
   const actual=await admin.query("SELECT e.display_name,SUM(s.net_sales_cents)::text AS attributed_cents,SUM(s.orders_count)::text AS attributed_orders FROM public.employee_sales_rollup s JOIN public.employees e ON e.id=s.employee_id WHERE s.business_id=$1 GROUP BY e.display_name",[ids.a]);
   expect(sales.rows).toEqual(actual.rows);
   expect(checkNumbers("Recorded employee-attributed sales were $42.00.","",[sales as unknown as AgentToolResult],"en")).toEqual([]);
  }finally{
   await admin.query("DELETE FROM public.employee_sales_rollup WHERE employee_id IN ($1,$2)",[employeeA,employeeB]);
   await admin.query("DELETE FROM public.employees WHERE id IN ($1,$2)",[employeeA,employeeB]);
   await admin.query("DELETE FROM public.locations WHERE id IN ($1,$2)",[locationA,locationB]);
  }
 });
 it("rechecks actual original-owner authorization after revocation",async()=>{
  if(!admin)throw Error("admin_missing");
  await admin.query("DELETE FROM public.memberships WHERE business_id=$1 AND user_id=$2",
   [ids.a,ids.oa]);
  const result=await dataQueryTools.query_data.execute(input(
   "SELECT COUNT(*) AS n FROM u3_research.orders"),scoped);
  expect(result.error).toBe("research_scope_denied");
  expect(result.rows).toEqual([]);
 });
});
