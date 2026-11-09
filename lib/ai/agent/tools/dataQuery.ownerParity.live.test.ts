/** Opt-in LIVE acceptance: real Supervisor agent, real migrated local PostgreSQL,
 * and independent SQL truth. Never points at production; fixture rolls back.
 * AGENT_LIVE_EVAL=1 AICAFE_QUERY_PARITY_LOCAL_DATABASE_URL=postgresql://... vitest run this file
 * Uses the normal one-agent loop and the existing query_data tool, not a copied prompt. */
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import pg from "pg";
import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {runAgentTurn,openAIProvider} from "../loop.server";
import {PRODUCTION_SUPERVISOR_OPENAI_MODEL} from "@/lib/ai/conversations/modelConfig";
import type {AgentProvider} from "../loop.server";
import type {AgentToolContext} from "./index";
const dbUrl=process.env.AICAFE_QUERY_PARITY_LOCAL_DATABASE_URL;
// A free, provider-independent dry run validates ALL fixture writes and
// tenant/diagnostic isolation before any paid call. This is NOT agent proof.
const sqlOnly=process.env.POS0E_E2_SQL_ONLY==="1";
const enabled=Boolean(dbUrl)&&(sqlOnly||
 (process.env.AGENT_LIVE_EVAL==="1"&&Boolean(process.env.OPENAI_API_KEY)));
const run=enabled?it:it.skip;

// The budget applies to the real model *transport*, across ALL turns in this
// disposable acceptance test. Serialized UTF-8 bytes conservatively bound
// provider-input tokens without requiring a paid tokenizer or extra API call.
// The primary is the verified Vercel production model gpt-6-luna, not the
// fallback gpt-4.1-mini. This cap bounds request bytes, model calls, and
// output tokens; actual provider billing may differ from any dollar estimate.
// Check BEFORE sending, including the provider's per-response output ceiling.
// A limit hit FAILS the test; it can never turn partial E2 into a passing proof.
const smoke=process.env.POS0E_E2_SMOKE==="1";
const MAX_PAID_CALLS=12;
const MAX_INPUT_REQUEST_BYTES=200_000;
const MAX_OUTPUT_TOKENS_PER_CALL=1_000;
let paidCalls=0,requestBytes=0,outputTokensReserved=0;
const budgetedProvider:AgentProvider=async function*(params,signal){
 if(params.model!==PRODUCTION_SUPERVISOR_OPENAI_MODEL)
  throw new Error("POS0e E2 requires owner-verified production Supervisor model "+PRODUCTION_SUPERVISOR_OPENAI_MODEL);
 const payloadBytes=Buffer.byteLength(JSON.stringify(params),"utf8");
 const outputCap=Math.min(Number(params.max_output_tokens)||MAX_OUTPUT_TOKENS_PER_CALL,
  MAX_OUTPUT_TOKENS_PER_CALL);
 if(paidCalls+1>MAX_PAID_CALLS||
    requestBytes+payloadBytes>MAX_INPUT_REQUEST_BYTES||
    outputTokensReserved+outputCap>MAX_PAID_CALLS*MAX_OUTPUT_TOKENS_PER_CALL)
  throw new Error("POS0e paid E2 budget exceeded: stop without additional API calls");
 paidCalls++;
 requestBytes+=payloadBytes;
 outputTokensReserved+=outputCap;
 yield* openAIProvider({...params,max_output_tokens:outputCap},signal);
};
const allowedHost=(raw:string)=>{
 const {hostname}=new URL(raw);
 if(!["127.0.0.1","localhost","::1"].includes(hostname))
  throw new Error("Parity fixture tests require a disposable LOCAL database, never production");
};
// Each expected value below comes from PostgreSQL over the fixture, not from a
// hardcoded answer or a mocked tool result. These questions exercise genuinely
// different paths: counts, distinct orders, mixed filters, time, items and gaps.
const scalarQuestions=[
 {question:"How many applied student discount uses did we record today? The day is still incomplete.",
  truth:`select count(*)::integer n from public.toast_records_for($1,$3,$3) where counts_in_sales=true and record_type in ('item_discount','check_discount') and data->>'name' ilike '%student%'`},
 {question:"How many different orders received a student discount today? Do not count checks as orders.",
  truth:`select count(distinct order_ref)::integer n from public.toast_records_for($1,$3,$3) where counts_in_sales=true and record_type in ('item_discount','check_discount') and data->>'name' ilike '%student%'`},
 {question:"How many distinct checks had student discounts today?",
  truth:`select count(distinct check_ref)::integer n from public.toast_records_for($1,$3,$3) where counts_in_sales=true and record_type in ('item_discount','check_discount') and data->>'name' ilike '%student%'`},
 {question:"How many valid item and check discount uses of any name are recorded today?",
  truth:`select count(*)::integer n from public.toast_records_for($1,$3,$3) where counts_in_sales=true and record_type in ('item_discount','check_discount')`},
 {question:"How many different applied discount names are there across yesterday and today?",
  truth:`select count(distinct data->>'name')::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type in ('item_discount','check_discount')`},
 {question:"How many individual item selections across these two days had quantity at least two?",
  truth:`select count(*)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type='item' and (data->>'quantity')::numeric>=2`},
 {question:"How many units of items were sold yesterday? Count units, not selection lines.",
  truth:`select sum((data->>'quantity')::numeric)::integer n from public.toast_records_for($1,$2,$2) where counts_in_sales=true and record_type='item'`},
 {question:"How many guests did Toast record yesterday, using the orders?",
  truth:`select sum((data->>'numberOfGuests')::numeric)::integer n from public.toast_records_for($1,$2,$2) where counts_in_sales=true and record_type='order'`},
 {question:"How many item selection records yesterday are missing their displayName?",
  truth:`select count(*)::integer n from public.toast_records_for($1,$2,$2) where counts_in_sales=true and record_type='item' and data->>'displayName' is null`},
 {question:"How many Online orders were recorded across yesterday and today?",
  truth:`select count(distinct record_ref)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type='order' and data->>'source'='Online'`},
 {question:"How many units are there today across all item selections, regardless of their number of lines?",
  truth:`select sum((data->>'quantity')::numeric)::integer n from public.toast_records_for($1,$3,$3) where counts_in_sales=true and record_type='item'`}
] as const;
run("Supervisor proves current-source orders, staff, cash, stock, names and screen parity",async()=>{
 allowedHost(dbUrl!);
 const client=new pg.Client({connectionString:dbUrl!});
 await client.connect();
 try{
  // Own transaction: the existing SQL parity fixture creates historical+live
  // Toast orders, validates the 10 query cases and deliberately has ROLLBACK.
  // Keep that transaction open for the real agent; always roll it back in finally.
  const raw=readFileSync(resolve("scripts/ai-data-query-distinct-sql-integration.sql"),"utf8");
  const fixture=raw.replace(/^\\set[^\n]*\n/gm,"").replace(/\nROLLBACK;\s*$/,"\n");
  if(fixture===raw||!fixture.includes("BEGIN;"))throw Error("Unsafe/missing parity fixture");
  await client.query(fixture);
  const biz=(await client.query<{id:string;timezone:string;today:string}>(
   `select id,timezone,(now() at time zone timezone)::date::text today
    from public.businesses where name='Query fixture café' limit 1`)).rows[0];
  if(!biz)throw Error("Disposable fixture café missing");
  const prior=(await client.query<{prior:string}>(
   "select ($1::date - 1)::text prior",[biz.today])).rows[0].prior;
  const params=[biz.id,prior,biz.today];
  // POS0e opt-in E2: all source-family facts are synthetic and inside the same
  // rollback transaction as the existing historic/live-order parity fixture.
  const restaurant="eeeeeeee-3333-4eee-8eee-eeeeeeeeee01";
  const staffGuid="eeeeeeee-3333-4eee-8eee-eeeeeeee00a1";
  const stockGuid="eeeeeeee-3333-4eee-8eee-eeeeeeee00b1";
  const firstOrderGuid="eeeeeeee-3333-4eee-8eee-eeeeeeee0001";
  const otherCafe="eeeeeeee-4444-4eee-8eee-eeeeeeeeee00";
  const otherRestaurant="eeeeeeee-4444-4eee-8eee-eeeeeeeeee01";
  await client.query("insert into public.businesses(id,name,is_demo) values($1,'Other synthetic café',false)",[otherCafe]);
  const modified=await client.query("update public.toast_raw_records set payload=payload ||\n jsonb_build_object('customer',jsonb_build_object('firstName','Maya','lastName','Shah','email','maya@example.test'))\n where business_id=$1 and entity='order' and payload->>'guid'=$2",[biz.id,firstOrderGuid]);
  expect(modified.rowCount).toBe(1);
  await client.query("insert into public.toast_raw_records\n (business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,capture_key)\n values\n ($1,$2,'employee',$3,$4::date,\n  jsonb_build_object('guid',$3::uuid::text,'firstName','Nadia','lastName','Rao','email','nadia@example.test'),\n  repeat('a',64),'pos0e:e2:employee'),\n ($1,$2,'labor/v1/timeEntries',null,$4::date,\n  jsonb_build_object('guid','time-pos0e','employeeGuid',$3::uuid::text,'regularHours',5.5),\n  repeat('a',64),'pos0e:e2:time'),\n ($1,$2,'cashmgmt/v1/entries',null,$4::date,\n  jsonb_build_object('guid','cash-pos0e','type','CASH_IN','amount',18.75,\n   'employee',jsonb_build_object('guid',$3::uuid::text)),repeat('a',64),'pos0e:e2:cash'),\n ($1,$2,'stock/v1/inventory',$5,$4::date,\n  jsonb_build_object('guid',$5::uuid::text,'quantity',4.5,'status','QUANTITY'),\n  repeat('a',64),'pos0e:e2:stock'),\n ($6,$7,'cashmgmt/v1/entries',null,$4::date,\n  '{\"guid\":\"other-cafe-cash\",\"amount\":9999.99,\"type\":\"CASH_IN\"}'::jsonb,\n  repeat('a',64),'pos0e:e2:other-cafe')",
   [biz.id,restaurant,staffGuid,biz.today,stockGuid,otherCafe,otherRestaurant]);
  // The poison is purposefully newer-looking, but NEVER an operational value.
  await client.query("insert into public.toast_raw_samples\n (business_id,restaurant_guid,endpoint,business_date,http_status,item_count,sample,field_paths)\n values\n ($1,$2,'cashmgmt/v1/entries',$3::date,200,1,'[{\"guid\":\"poison-cash\",\"amount\":9999.99}]'::jsonb,'{}'::jsonb),\n ($1,$2,'stock/v1/inventory',$3::date,200,1,'[{\"guid\":\"poison-stock\",\"quantity\":9999}]'::jsonb,'{}'::jsonb),\n ($1,$2,'labor/v1/timeEntries',$3::date,200,1,'[{\"guid\":\"poison-time\",\"firstName\":\"PoisonEmployee\"}]'::jsonb,'{}'::jsonb)",[biz.id,restaurant,biz.today]);
  const leak=(await client.query<{n:number}>("select count(*)::integer n from public.toast_records_for($1,$2,$3)\n where data->>'guid' in ('other-cafe-cash','poison-cash','poison-stock','poison-time')",
   [biz.id,prior,biz.today])).rows[0].n;
  expect(leak).toBe(0);
  // Test the source/fixture contract at zero model cost. Paid acceptance must
  // still execute the registered Supervisor, and never sets SQL_ONLY.
  if(sqlOnly){
   const expected=await client.query<{n:number}>(
    "select count(*)::integer n from public.toast_records_for($1,$2,$3) where record_type in ('employee','cashmgmt/v1/entries','stock/v1/inventory')",
    [biz.id,prior,biz.today]);
   expect(expected.rows[0].n).toBeGreaterThanOrEqual(3);
   return;
  }

  // SupabaseClient.rpc-compatible adapter backed by the SAME transaction in which
  // the fixture and direct truth live. Query SQL is still solely the allowlisted RPC.
  const db={rpc:async(name:string,p:Record<string,unknown>)=>{
   if(name==="ai_query_view"){
    const args=[p.p_business_id,p.p_view,p.p_columns,JSON.stringify(p.p_filters),
     p.p_group_by,JSON.stringify(p.p_metrics),p.p_date_from,p.p_date_to,
     p.p_order_by===null?null:JSON.stringify(p.p_order_by),p.p_limit];
    const result=await client.query(
     "select public.ai_query_view($1::uuid,$2::text,$3::text[],$4::jsonb,$5::text[],$6::jsonb,$7::date,$8::date,$9::jsonb,$10::integer) value",
     args);
    return {data:result.rows[0].value,error:null};
   }
   if(name==="ai_toast_fields"){
    const result=await client.query("select public.ai_toast_fields($1::uuid,$2::text) value",
     [p.p_business_id,p.p_record_type]);
    return {data:result.rows[0].value,error:null};
   }
   throw Error("Unexpected RPC: "+name);
  }};
  const context={
   asOf:biz.today,timezone:biz.timezone,locale:"en",
   tools:{} as AgentToolContext["tools"],
   canonicalData:async()=>({db:db as never,businessId:biz.id})
  } as AgentToolContext;
  for(const {question,truth} of (smoke?scalarQuestions.slice(0,0):scalarQuestions)){
   const expected=(await client.query<{n:number}>(truth,params)).rows[0].n;
   // Standard owner-facing answer; the requested line keeps acceptance numeric
   // (without an extra reviewer model) and still permits the incomplete-day note.
   const turn=await runAgentTurn({context,provider:budgetedProvider,ownerText:
    question+" Answer with 'Number: N' and a short source/coverage note."});
   expect(turn.tools,question).toContain("query_data");
   const number=turn.text.match(/\bNumber\s*[:=]\s*(\d+)\b/i);
   expect(number,question+" => "+turn.text).not.toBeNull();
   expect(Number(number![1]),question+" => "+turn.text).toBe(expected);
   if(question.includes("today"))
    expect(turn.text,question+" => "+turn.text).toMatch(/so far|partial|incomplete|provisional/i);
  }
  const breakdowns=[
   {question:"Give applied discount USE counts for yesterday and today, one line per date as YYYY-MM-DD: N.",
    truth:`select business_date::text k,count(*)::integer n from public.toast_records_for($1,$2,$3) where record_type in ('item_discount','check_discount') and counts_in_sales=true group by business_date order by business_date`},
   {question:"Give units sold yesterday by item display name. Call absent names 'Unnamed'. Use Name: N lines.",
    truth:`select coalesce(data->>'displayName','Unnamed') k, sum((data->>'quantity')::numeric)::integer n from public.toast_records_for($1,$2,$2) where record_type='item' and counts_in_sales=true group by coalesce(data->>'displayName','Unnamed') order by 1`}
  ] as const;
  for(const {question,truth} of (smoke?breakdowns.slice(0,0):breakdowns)){
   const expected=(await client.query<{k:string;n:number}>(truth,params)).rows;
   const turn=await runAgentTurn({context,provider:budgetedProvider,ownerText:question});
   expect(turn.tools,question).toContain("query_data");
   for(const row of expected){
    const line=turn.text.split("\n").find(line=>line.includes(row.k));
    expect(line,question+" missing "+row.k+": "+turn.text).toBeTruthy();
    expect(line,question+" wrong "+row.k+": "+turn.text).toMatch(
     new RegExp("[:=]\\s*"+row.n+"\\b"));
   }
  }

  // These real turns close the signed POS0e gap not covered by the earlier
  // discount-only test. Expected facts come from the SAME disposable database
  // transaction, not the model, snapshots or copied fixture guesses.
  const namedQuestions=[
   {question:"For current Toast order GUID "+firstOrderGuid+
     ", what is this customer's first name? Answer exactly Name: X.",
    truth:"select data->'customer'->>'firstName' answer\n from public.toast_records_for($1,$2,$3)\n where record_type='order' and record_ref=$4",ref:firstOrderGuid},
   {question:"For current Toast employee GUID "+staffGuid+
     ", what is this employee's first name? Answer exactly Name: X.",
    truth:"select data->>'firstName' answer\n from public.toast_records_for($1,$2,$3)\n where record_type='employee' and record_ref=$4",ref:staffGuid}
  ];
  for(const {question,truth,ref} of namedQuestions){
   const expected=(await client.query<{answer:string}>(truth,[...params,ref])).rows[0]?.answer;
   expect(expected,question).toBeTruthy();
   const turn=await runAgentTurn({context,provider:budgetedProvider,ownerText:question+
    " Use retained current source facts, not diagnostic snapshots or another café."});
   expect(turn.tools,question).toContain("query_data");
   expect(turn.text,question).toMatch(new RegExp("\\bName\\s*[:=]\\s*"+expected+"\\b","i"));
  }
  const familyQuestions=[
   {question:"What is this café's total current Toast cash entries today in integer cents? Answer Cents: N; no diagnostic or other-café amounts.",
    truth:"select sum(amount_cents)::integer n from public.cv_cash\n where business_id=$1 and business_date=$2",label:"Cents",args:[biz.id,biz.today]},
   {question:"For current Toast stock item GUID "+stockGuid+
     ", what quantity is retained today? Answer Quantity: N; do not treat missing as zero.",
    truth:"select sum(quantity)::numeric n from public.cv_inventory\n where business_id=$1 and business_date=$2 and menu_item_ref=$3",label:"Quantity",args:[biz.id,biz.today,stockGuid]},
   {question:"What is yesterday's canonical screen net sales for this café in integer cents? Use the daily sales rollup, not raw order guesses. Answer Cents: N.",
    truth:"select sum(net_sales_cents)::integer n from public.cv_sales_days\n where business_id=$1 and business_date=$2",label:"Cents",args:[biz.id,prior]}
  ];
  for(const {question,truth,label,args} of familyQuestions){
   const expected=(await client.query<{n:number|string|null}>(truth,args)).rows[0]?.n;
   expect(expected,question).not.toBeNull();
   expect(expected,question).not.toBeUndefined();
   const turn=await runAgentTurn({context,provider:budgetedProvider,ownerText:question});
   expect(turn.tools,question).toContain("query_data");
   const match=turn.text.match(new RegExp("\\b"+label+"\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)","i"));
   expect(match,question+" => "+turn.text).not.toBeNull();
   expect(Number(match![1]),question+" => "+turn.text).toBeCloseTo(Number(expected),2);
  }
 }finally{
  await client.query("ROLLBACK").catch(()=>{});
  await client.end();
 }
},1_200_000);
