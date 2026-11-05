/** Opt-in LIVE acceptance: real Supervisor agent, real migrated local PostgreSQL,
 * and independent SQL truth. Never points at production; fixture rolls back.
 * AGENT_LIVE_EVAL=1 AICAFE_QUERY_PARITY_LOCAL_DATABASE_URL=postgresql://... vitest run this file
 * Uses the normal one-agent loop and the existing query_data tool, not a copied prompt. */
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import pg from "pg";
import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {runAgentTurn} from "../loop.server";
import type {AgentToolContext} from "./index";
const dbUrl=process.env.AICAFE_QUERY_PARITY_LOCAL_DATABASE_URL;
const enabled=process.env.AGENT_LIVE_EVAL==="1"&&Boolean(dbUrl&&process.env.OPENAI_API_KEY);
const run=enabled?it:it.skip;
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
run("Supervisor answers 13 varied owner questions with exact direct SQL counts and breakdowns",async()=>{
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
  for(const {question,truth} of scalarQuestions){
   const expected=(await client.query<{n:number}>(truth,params)).rows[0].n;
   // Standard owner-facing answer; the requested line keeps acceptance numeric
   // (without an extra reviewer model) and still permits the incomplete-day note.
   const turn=await runAgentTurn({context,ownerText:
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
  for(const {question,truth} of breakdowns){
   const expected=(await client.query<{k:string;n:number}>(truth,params)).rows;
   const turn=await runAgentTurn({context,ownerText:question});
   expect(turn.tools,question).toContain("query_data");
   for(const row of expected){
    const line=turn.text.split("\n").find(line=>line.includes(row.k));
    expect(line,question+" missing "+row.k+": "+turn.text).toBeTruthy();
    expect(line,question+" wrong "+row.k+": "+turn.text).toMatch(
     new RegExp("[:=]\\s*"+row.n+"\\b"));
   }
  }
 }finally{
  await client.query("ROLLBACK").catch(()=>{});
  await client.end();
 }
},1_200_000);
