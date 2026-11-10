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
import {executeAgentTool,type AgentToolContext} from "./index";
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
// The cost-capped smoke is a system-initiated reader acceptance, so expose
// only the TWO existing registered read tools, not unrelated action/scheduling
// schemas on every paid turn. The full suite still uses the unrestricted
// production Supervisor toolset; never claim smoke proves that whole surface.
const smokeReaderTools=["describe_data","query_data"] as const;
// Owner explicitly approved ONE additional cost-capped five-question Luna smoke.
// Full 18-question acceptance intentionally retains its earlier stricter cap;
// a larger full run requires its own separate authorization.
const MAX_PAID_CALLS=smoke?16:12;
const MAX_INPUT_REQUEST_BYTES=smoke?600_000:200_000;
const MAX_OUTPUT_TOKENS_PER_CALL=1_000;
let paidCalls=0,requestBytes=0,outputTokensReserved=0;
// A rejected transport budget is not an OpenAI/Luna failure. Never include
// prompts, tool parameters, customer rows or secrets in this diagnostic.
let budgetRejection:{reason:string;attemptBytes:number;priorBytes:number;
 priorCalls:number;attemptOutputTokens:number}|null=null;
// Record only response status, token counts and output item TYPES, never
// provider text, prompts, tool arguments, credentials or customer data.
const providerReceipts:Array<{event:string;status:string;reason:string|null;
 outputTokens:number|null;outputTypes:string[]}>= [];
// Only approved static column identifiers and SQLSTATE are ever recorded.
// Never log filter VALUES, SQL text, raw rows, model arguments or credentials.
const diagnosticFields=new Set(["amount_cents","quantity","net_sales_cents",
 "business_date","record_type","record_ref","menu_item_ref",
 "data.firstName","data.customer.firstName"]);
const safeField=(value:unknown)=>typeof value==="string"&&diagnosticFields.has(value)?
 value:"other";
const sqlFailures:Array<{sqlstate:string;view:string;columns:string[];
 filterColumns:string[];filterOperators:string[];metricFns:string[];metricColumns:string[]}>= [];
const budgetedProvider:AgentProvider=async function*(params,signal){
 if(params.model!==PRODUCTION_SUPERVISOR_OPENAI_MODEL)
  throw new Error("POS0e E2 requires owner-verified production Supervisor model "+PRODUCTION_SUPERVISOR_OPENAI_MODEL);
 const payloadBytes=Buffer.byteLength(JSON.stringify(params),"utf8");
 const outputCap=Math.min(Number(params.max_output_tokens)||MAX_OUTPUT_TOKENS_PER_CALL,
  MAX_OUTPUT_TOKENS_PER_CALL);
 const reason=paidCalls+1>MAX_PAID_CALLS?"model_call_count":
  requestBytes+payloadBytes>MAX_INPUT_REQUEST_BYTES?"input_request_bytes":
  outputTokensReserved+outputCap>MAX_PAID_CALLS*MAX_OUTPUT_TOKENS_PER_CALL?
   "output_token_reservation":null;
 if(reason){
  budgetRejection={reason,attemptBytes:payloadBytes,priorBytes:requestBytes,
   priorCalls:paidCalls,attemptOutputTokens:outputCap};
  throw new Error("POS0e paid E2 budget exceeded ("+reason+"): stop without additional API calls");
 }
 paidCalls++;
 requestBytes+=payloadBytes;
 outputTokensReserved+=outputCap;
 for await(const event of openAIProvider({...params,max_output_tokens:outputCap},signal)){
  if(["response.completed","response.incomplete","response.failed"].includes(event.type)){
   const response=event.response as {status?:string;incomplete_details?:{reason?:string}|null;
    usage?:{output_tokens?:number};output?:Array<{type?:string}>}|undefined;
   providerReceipts.push({event:event.type,status:response?.status??"unknown",
    reason:response?.incomplete_details?.reason??null,
    outputTokens:response?.usage?.output_tokens??null,
    outputTypes:(response?.output??[]).map(item=>item.type??"unknown")});
  }
  yield event;
 }
};
function safeFailureDetails(turn:Awaited<ReturnType<typeof runAgentTurn>>,since:number):string{
 return JSON.stringify({endReason:turn.endReason,
  modelCalls:turn.usage.modelCalls,inputTokens:turn.usage.inputTokens,
  cachedTokens:turn.usage.cachedTokens,outputTokens:turn.usage.outputTokens,
  chargedTransportCalls:paidCalls,serializedRequestBytes:requestBytes,
  outputTokensReserved,budgetRejection,
  tools:turn.tools,
  resultStatus:turn.results.map(result=>({source:result.source,
   missing:result.missing,error:result.error??null})),
  providerReceipts:providerReceipts.slice(since),sqlFailures:sqlFailures.slice(-3)});
}
// Free deterministic regression: a bad or overlarge provider request must be
// rejected BEFORE calling OpenAI, without mistaking the guard for Luna failure.
it("POS0e paid transport refuses an oversized request at zero model cost",async()=>{
 const beforeCalls=paidCalls,beforeBytes=requestBytes;
 const oversized={model:PRODUCTION_SUPERVISOR_OPENAI_MODEL,
  max_output_tokens:MAX_OUTPUT_TOKENS_PER_CALL,
  input:"x".repeat(MAX_INPUT_REQUEST_BYTES)};
 await expect(budgetedProvider(oversized,new AbortController().signal)[Symbol.asyncIterator]().next())
  .rejects.toThrow("POS0e paid E2 budget exceeded (input_request_bytes)");
 expect(paidCalls).toBe(beforeCalls);
 expect(requestBytes).toBe(beforeBytes);
 expect(budgetRejection).toMatchObject({reason:"input_request_bytes"});
 budgetRejection=null;
});

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
  await client.query("insert into public.toast_raw_samples\n (business_id,restaurant_guid,endpoint,business_date,http_status,item_count,sample,field_paths)\n values\n ($1,$2,'cashmgmt/v1/entries',$3::date,200,1,'[{\"guid\":\"poison-cash\",\"amount\":9999.99}]'::jsonb,ARRAY[]::text[]),\n ($1,$2,'stock/v1/inventory',$3::date,200,1,'[{\"guid\":\"poison-stock\",\"quantity\":9999}]'::jsonb,ARRAY[]::text[]),\n ($1,$2,'labor/v1/timeEntries',$3::date,200,1,'[{\"guid\":\"poison-time\",\"firstName\":\"PoisonEmployee\"}]'::jsonb,ARRAY[]::text[])",[biz.id,restaurant,biz.today]);
  const leak=(await client.query<{n:number}>("select count(*)::integer n from public.toast_records_for($1,$2,$3)\n where data->>'guid' in ('other-cafe-cash','poison-cash','poison-stock','poison-time')",
   [biz.id,prior,biz.today])).rows[0].n;
  expect(leak).toBe(0);
  // Independent SQL truths are shared by the free preflight and the real agent
  // assertions; a broken bind cannot silently burn a paid Luna run.
  const namedQuestions=[
   {question:"For current Toast order GUID "+firstOrderGuid+
     ", what is this customer's first name? Answer exactly Name: X.",
    truth:"select data->'customer'->>'firstName' answer\n from public.toast_records_for($1,$2,$3)\n where record_type='order' and record_ref=$4",ref:firstOrderGuid},
   {question:"For current Toast employee GUID "+staffGuid+
     ", what is this employee's first name? Answer exactly Name: X.",
    truth:"select data->>'firstName' answer\n from public.toast_records_for($1,$2,$3)\n where record_type='employee' and record_ref=$4",ref:staffGuid}
  ];
  const familyQuestions=[
   {question:"What is this café's total current Toast cash entries today in integer cents? Answer Cents: N; no diagnostic or other-café amounts.",
    truth:"select sum(amount_cents)::integer n from public.cv_cash\n where business_id=$1 and business_date=$2",label:"Cents",args:[biz.id,biz.today]},
   {question:"For current Toast stock item GUID "+stockGuid+
     ", what quantity is retained today? Answer Quantity: N; do not treat missing as zero.",
    truth:"select sum(quantity)::numeric n from public.cv_inventory\n where business_id=$1 and business_date=$2 and menu_item_ref=$3",label:"Quantity",args:[biz.id,biz.today,stockGuid]},
   {question:"What is yesterday's canonical screen net sales for this café in integer cents? Use the daily sales rollup, not raw order guesses. Answer Cents: N.",
    truth:"select sum(net_sales_cents)::integer n from public.cv_sales_days\n where business_id=$1 and business_date=$2",label:"Cents",args:[biz.id,prior]}
  ];
  // Test the source/fixture contract at zero model cost. Paid acceptance must
  // still execute the registered Supervisor, and never sets SQL_ONLY.
  // The source-shaped fixture lives inside one rollback transaction, but
  // real Supabase RPC calls each have their own transaction. A malformed
  // model query must NOT poison the fixture or later valid requests.
  // Serialize savepoints because the pg.Client has only one connection.
  let rpcTail:Promise<void>=Promise.resolve();
  const isolatedRpc=async (work:()=>Promise<unknown>)=>{
   let release!:()=>void;
   const prior=rpcTail;
   rpcTail=new Promise<void>(resolve=>{release=resolve;});
   await prior;
   try{
    await client.query("SAVEPOINT pos0e_rpc");
    try{
     const data=await work();
     await client.query("RELEASE SAVEPOINT pos0e_rpc");
     return {data,error:null};
    }catch(error){
     await client.query("ROLLBACK TO SAVEPOINT pos0e_rpc");
     await client.query("RELEASE SAVEPOINT pos0e_rpc");
     // Equivalent safe Supabase RPC error code; never expose a SQL statement,
     // provider text, row values or PostgreSQL's sensitive error message.
     const code=error&&typeof error==="object"&&"code" in error?
      (error as {code?:unknown}).code:null;
     return {data:null,error:{code:typeof code==="string"?code:"XX000"}};
    }
   }finally{release();}
  };
  const db={rpc:async(name:string,p:Record<string,unknown>)=>{
   if(name==="ai_query_view")return isolatedRpc(async()=>{
    const args=[p.p_business_id,p.p_view,p.p_columns,JSON.stringify(p.p_filters),
     p.p_group_by,JSON.stringify(p.p_metrics),p.p_date_from,p.p_date_to,
     p.p_order_by===null?null:JSON.stringify(p.p_order_by),p.p_limit];
    const result=await client.query(
     "select public.ai_query_view($1::uuid,$2::text,$3::text[],$4::jsonb,$5::text[],$6::jsonb,$7::date,$8::date,$9::jsonb,$10::integer) value",
     args);
    return result.rows[0].value;
   });
   if(name==="ai_toast_fields")return isolatedRpc(async()=>{
    const result=await client.query("select public.ai_toast_fields($1::uuid,$2::text) value",
     [p.p_business_id,p.p_record_type]);
    return result.rows[0].value;
   });
   throw Error("Unexpected RPC: "+name);
  }};
  const context={
   asOf:biz.today,timezone:biz.timezone,locale:"en",
   tools:{} as AgentToolContext["tools"],
   canonicalData:async()=>({db:db as never,businessId:biz.id})
  } as AgentToolContext;
  if(sqlOnly){
   const expected=await client.query<{n:number}>(
    "select count(*)::integer n from public.toast_records_for($1,$2,$3) where record_type in ('employee','cashmgmt/v1/entries','stock/v1/inventory')",
    [biz.id,prior,biz.today]);
   expect(expected.rows[0].n).toBeGreaterThanOrEqual(3);
   // Exact same independently sourced truth SQL and bound argument arrays as
   // the real-agent test; no provider/model request in SQL-only mode.
   for(const {question,truth,ref} of namedQuestions){
    const truthRow=(await client.query<{answer:string}>(truth,[...params,ref])).rows[0];
    expect(truthRow?.answer,question).toBeTruthy();
   }
   for(const {question,truth,args} of familyQuestions){
    const truthRow=(await client.query<{n:number|string|null}>(truth,args)).rows[0];
    expect(truthRow?.n,question).not.toBeNull();
    expect(truthRow?.n,question).not.toBeUndefined();
   }
   // A known Toast GUID should resolve without guessing a different family.
   // Same registered query_data, scope, and real SQL used by the paid agent;
   // the free preflight must catch a broken field path before spending tokens.
   const namedToolCases=[
    {recordType:"order",ref:firstOrderGuid,field:"data.customer.firstName"},
    {recordType:"employee",ref:staffGuid,field:"data.firstName"}
   ];
   for(const spec of namedToolCases){
    const expected=(await client.query<{answer:string}>(
     "select case when $3='order' then data->'customer'->>'firstName' else data->>'firstName' end answer from public.toast_records_for($1,$4,$5) where record_type=$3 and record_ref=$2",
     [biz.id,spec.ref,spec.recordType,prior,biz.today])).rows[0]?.answer;
    expect(expected,spec.recordType+" source truth").toBeTruthy();
    const result=await executeAgentTool("query_data",{
     view:"cv_toast_records",columns:[spec.field],
     filters:[{column:"record_type",op:"=",value:spec.recordType},
      {column:"record_ref",op:"=",value:spec.ref}],
     group_by:null,metrics:null,date_from:prior,date_to:biz.today,
     order_by:null,limit:10
    },context);
    expect(result.error,spec.recordType+" registered reader").toBeUndefined();
    const rows=result.rows as Array<Record<string,unknown>>|undefined;
    expect(rows,spec.recordType+" registered reader").toHaveLength(1);
    expect(rows?.[0]?.[spec.field],spec.recordType+" permitted first name")
     .toBe(expected);
   }
   // A schema-valid but SQL-invalid aggregate must not abort the shared
   // uncommitted fixture. This is the failure mode production RPC isolation
   // handles but a naive pg.Client transaction does not.
   const rejected=await executeAgentTool("query_data",{
    view:"cv_cash",columns:null,filters:null,group_by:null,
    metrics:[{fn:"sum",column:"entry_type"}],
    date_from:biz.today,date_to:biz.today,order_by:null,limit:10
   },context);
   expect(rejected.error).toBe("invalid_query");
   // Prove the real registered query_data dispatch and SQL RPC, not just a
   // direct SELECT of the source. This never reaches a model provider.
   const familyToolCases=[
    {view:"cv_cash" as const,metric:"amount_cents",day:biz.today,filters:null},
    {view:"cv_inventory" as const,metric:"quantity",day:biz.today,
     filters:[{column:"menu_item_ref",op:"=",value:stockGuid}]},
    {view:"cv_sales_days" as const,metric:"net_sales_cents",day:prior,filters:null}
   ];
   for(const [index,testCase] of familyToolCases.entries()){
    const spec=familyQuestions[index];
    const truthValue=(await client.query<{n:number|string|null}>(spec.truth,spec.args)).rows[0]?.n;
    const result=await executeAgentTool("query_data",{
     view:testCase.view,columns:null,filters:testCase.filters,
     group_by:null,metrics:[{fn:"sum",column:testCase.metric}],
     date_from:testCase.day,date_to:testCase.day,order_by:null,limit:10
    },context);
    expect(result.error,spec.question+"; "+JSON.stringify(result.missing)).toBeUndefined();
    expect(result.missing,spec.question).not.toContain("source_read_failed");
    const rows=result.rows as Array<Record<string,unknown>>|undefined;
    expect(rows,spec.question).toHaveLength(1);
    expect(Number(rows?.[0]?.["sum_"+testCase.metric]),spec.question)
     .toBeCloseTo(Number(truthValue),2);
   }
   return;
  }

  for(const {question,truth} of (smoke?scalarQuestions.slice(0,0):scalarQuestions)){
   const expected=(await client.query<{n:number}>(truth,params)).rows[0].n;
   // Standard owner-facing answer; the requested line keeps acceptance numeric
   // (without an extra reviewer model) and still permits the incomplete-day note.
   const turn=await runAgentTurn({context,toolNames:smoke?smokeReaderTools:undefined,
   provider:budgetedProvider,ownerText:
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
   const turn=await runAgentTurn({context,toolNames:smoke?smokeReaderTools:undefined,
   provider:budgetedProvider,ownerText:question});
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
  for(const {question,truth,ref} of namedQuestions){
   const expected=(await client.query<{answer:string}>(truth,[...params,ref])).rows[0]?.answer;
   expect(expected,question).toBeTruthy();
   const receiptStart=providerReceipts.length;
   const turn=await runAgentTurn({context,toolNames:smoke?smokeReaderTools:undefined,
   provider:budgetedProvider,ownerText:question+
    " Use retained current source facts, not diagnostic snapshots or another café."});
   expect(turn.tools,question).toContain("query_data");
   expect(turn.text,question+"; "+safeFailureDetails(turn,receiptStart))
    .toMatch(new RegExp("\\bName\\s*[:=]\\s*"+expected+"\\b","i"));
  }
  for(const {question,truth,label,args} of familyQuestions){
   const expected=(await client.query<{n:number|string|null}>(truth,args)).rows[0]?.n;
   expect(expected,question).not.toBeNull();
   expect(expected,question).not.toBeUndefined();
   const receiptStart=providerReceipts.length;
   const turn=await runAgentTurn({context,toolNames:smoke?smokeReaderTools:undefined,
   provider:budgetedProvider,ownerText:question});
   expect(turn.tools,question).toContain("query_data");
   const match=turn.text.match(new RegExp("\\b"+label+"\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)","i"));
   expect(match,question+" => "+turn.text+"; "+safeFailureDetails(turn,receiptStart)).not.toBeNull();
   expect(Number(match![1]),question+" => "+turn.text).toBeCloseTo(Number(expected),2);
  }
 }finally{
  await client.query("ROLLBACK").catch(()=>{});
  await client.end();
 }
},1_200_000);
