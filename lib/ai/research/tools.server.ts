import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {Client} from "pg";
import {calculationToolDefinition,executeCalculationTool} from "./calculation";
export {calculate} from "./calculation";

/** Supervisor SQL research tools: describe_database, run_sql (one read-only SELECT run by the database
 * function `supervisor_research_sql` as the verified owner under RLS, one café) and calculate (existing
 * exact calculator). Security is enforced in the database; no business logic here. */

export type ResearchScope={db:SupabaseClient;businessId:string;ownerUserId:string;
  signal?:AbortSignal;
  /** The existing owner-permissioned public web search (one path); absent when unavailable. */
  webSearch?:(query:string,signal?:AbortSignal)=>Promise<unknown>;
  /** Text read from the café's private data this turn; a public query may not contain it. */
  privateValues?:Set<string>;
  /** Café notes (what Supervisor has learned about this café), saved with the owner's own session. */
  notes?:{save:(topic:string,note:string,basis:string)=>Promise<void>;forget:(topic:string)=>Promise<boolean>}};

type ResearchDatabaseScope = Pick<ResearchScope, "businessId" | "ownerUserId" | "signal"> &
  Partial<Pick<ResearchScope, "db">>;

/** Remember everything read from café data (text and numbers, at any depth) so none of it is sent to a public search. */
function rememberPrivate(scope:ResearchScope,rows:unknown){
  if(!scope.privateValues)return;
  const visit=(value:unknown,depth:number)=>{
    if(depth>8||value===null||value===undefined)return;
    if(typeof value==="string"){
      const text=value.trim().toLowerCase();
      if(text.length>=4&&text.length<=200&&!/^[\d\s.,:/-]+$/u.test(text))scope.privateValues!.add(text);
      // A JSON value can be stored as text: read inside it too.
      if(/^[[{]/u.test(text))try{visit(JSON.parse(value),depth+1);}catch{/* plain text */}
      return;
    }
    if(typeof value==="number"){
      // Public searches may name a year; any other figure from the café's data stays private.
      if(Number.isFinite(value)&&Math.abs(value)>=100&&!(Number.isInteger(value)&&value>=1990&&value<=2100))
        scope.privateValues!.add("#"+String(value));
      return;
    }
    if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return;}
    if(typeof value==="object")for(const item of Object.values(value as Record<string,unknown>))visit(item,depth+1);
  };
  visit(rows,0);
}
function privateTextIn(scope:ResearchScope,query:string):string|null{
  const q=query.toLowerCase();
  const figures=new Set((q.match(/\d[\d.,]*\d|\d/gu)??[]).map(t=>t.replace(/,/gu,"")));
  for(const v of scope.privateValues??[]){
    if(v.startsWith("#")){if(figures.has(v.slice(1)))return v.slice(1);continue;}
    if(q.includes(v))return v;
  }
  return null;
}

export const describeDatabaseToolDefinition = {type:"function",name:"describe_database",strict:true,
    description:"Discover the café database you can read. With tables=null: every readable table and view with its description and columns. "+
      "With table names: each column's type, nullability and description, allowed values (check constraints), and foreign keys to and from those tables.",
    parameters:{type:"object",additionalProperties:false,required:["tables"],properties:{
      tables:{type:["array","null"],items:{type:"string"},description:"Table or view names, or null for the full list."}}}} as const;

export const researchToolDefinitions=[
  describeDatabaseToolDefinition,
  {type:"function",name:"run_sql",strict:true,
    description:"Run one read-only PostgreSQL SELECT (WITH, joins, window functions, aggregates and subqueries are fine) on this café's data. "+
      "Rows are already limited to this café by the database. Returns every row the query produces. "+
      "On an error you get PostgreSQL's message; fix the SQL and try again.",
    parameters:{type:"object",additionalProperties:false,required:["sql"],properties:{
      sql:{type:"string",description:"A single SELECT statement."}}}},
  {type:"function",name:"search_web",strict:true,
    description:"Search the public web for current outside information, such as the labor, tax or health rules for this café's own location. "+
      "Returns a short sourced summary. Never put private café data in the query.",
    parameters:{type:"object",additionalProperties:false,required:["query"],properties:{
      query:{type:"string",description:"A public question, including the café's city and state or country when location matters."}}}},
  calculationToolDefinition,
  {type:"function",name:"remember_cafe_note",strict:true,
    description:"Save something you learned about this café that will help next time (a pattern, a habit, a working assumption, a preference), "+
      "or update an existing note by reusing its topic. Say where it came from. Notes can go stale and live data always wins, so do not save numbers that are better read from the database. "+
      "Tell the owner when you save one.",
    parameters:{type:"object",additionalProperties:false,required:["topic","note","basis"],properties:{
      topic:{type:"string",description:"Short lowercase key such as busy_hours or staff.break_habits."},
      note:{type:"string",description:"The note, in plain words."},
      basis:{type:"string",description:"What it was learned from (the data you read, or what the owner said), with the date."}}}},
  {type:"function",name:"forget_cafe_note",strict:true,
    description:"Retire a café note by topic, when it is wrong, outdated, or the owner asks you to forget it.",
    parameters:{type:"object",additionalProperties:false,required:["topic"],properties:{topic:{type:"string"}}}},
] as const;

const databaseUnavailable = {ok:false,error:"research_database_connection_unavailable"} as const;

async function callDatabase(scope:ResearchDatabaseScope,sql:string):Promise<Record<string,unknown>>{
  // PostgREST has an independent hosting request deadline. A dedicated
  // restricted direct/session connection uses the same RLS SQL executor,
  // with no statement or client query timeout and no arbitrary role change.
  const connectionString=process.env.SUPERVISOR_RESEARCH_DATABASE_URL;
  if(connectionString){
    if(scope.signal?.aborted)return {ok:false,error:"research_execution_interrupted"};
    const client=new Client({connectionString,statement_timeout:0,query_timeout:0});
    const abort=()=>{void client.end().catch(()=>undefined);};
    scope.signal?.addEventListener("abort",abort,{once:true});
    try{
      await client.connect();
      if(scope.signal?.aborted)return {ok:false,error:"research_execution_interrupted"};
      const result=await client.query("select public.supervisor_research_sql($1::uuid,$2::uuid,$3::text) as result",[scope.businessId,scope.ownerUserId,sql]); // hardcode-ok: PostgreSQL positional bind parameters, not monetary literals
      const value=result.rows[0]?.result;
      return value&&typeof value==="object"?value as Record<string,unknown>:{ok:false,error:"empty_database_response"};
    }catch(error){
      return {ok:false,error:scope.signal?.aborted?"research_execution_interrupted":"research_database_transport_failed",...(typeof (error as {code?:unknown})?.code==="string"?{sqlstate:(error as {code:string}).code}:{})};
    }finally{scope.signal?.removeEventListener("abort",abort);await client.end().catch(()=>undefined);}
  }
  if(!scope.db)return databaseUnavailable;
  const request=scope.db.rpc("supervisor_research_sql",{
    p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_sql:sql});
  const {data,error}=await (scope.signal&&typeof request.abortSignal==="function"?request.abortSignal(scope.signal):request);
  if(error)return {ok:false,error:error.message,sqlstate:error.code};
  return data&&typeof data==="object"?data as Record<string,unknown>:{ok:false,error:"empty_database_response"};
}

/** The database function enforces one read-only SELECT and returns PostgreSQL's own errors. */
export async function runSql(scope:ResearchScope,sql:string):Promise<Record<string,unknown>>{
  return callDatabase(scope,sql);
}

const IDENT=/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
// Raw diagnostic snapshots are never café evidence (AGENTS.md operational-source rule); the database function also refuses them.
const OPERATIONAL="c.relname !~ '^(toast_raw_sample|diag_|diagnostic_|test_|fixture_)'";
const RELATIONS="from pg_class c join pg_namespace n on n.oid=c.relnamespace "+
  "where n.nspname='public' and c.relkind in ('r','p','v','m') and has_table_privilege(c.oid,'select') and "+OPERATIONAL;
export async function describeDatabase(scope:ResearchDatabaseScope,tables:readonly string[]|null):Promise<Record<string,unknown>>{
  if(!scope.db&&!process.env.SUPERVISOR_RESEARCH_DATABASE_URL)return databaseUnavailable;
  if(!tables||!tables.length){
    return callDatabase(scope,"select c.relname as name, case when c.relkind in ('v','m') then 'view' else 'table' end as kind, "+
      "obj_description(c.oid,'pg_class') as description, (select string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod), ', ' order by a.attnum) "+
      "from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns "+RELATIONS+" order by 1");
  }
  const names=tables.filter(t=>IDENT.test(t));
  const ignored=tables.filter(t=>!IDENT.test(t));
  const list="array["+names.map(t=>"'"+t+"'").join(",")+"]::text[]";
  const [columns,links]=await Promise.all([
    callDatabase(scope,"select c.relname as table, a.attname as column, format_type(a.atttypid,a.atttypmod) as type, "+
      "not a.attnotnull as nullable, col_description(c.oid,a.attnum) as description "+
      "from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace "+
      "where n.nspname='public' and c.relname = any("+list+") and has_table_privilege(c.oid,'select') and "+OPERATIONAL+" "+
      "and a.attnum>0 and not a.attisdropped order by c.relname, a.attnum"),
    callDatabase(scope,"with readable as (select c.oid, c.relname "+RELATIONS+") "+
      "select case k.contype when 'f' then 'foreign_key' else 'allowed_values' end as kind, "+
      "src.relname as table, dst.relname as references, pg_get_constraintdef(k.oid) as definition "+
      "from pg_constraint k join readable src on src.oid=k.conrelid left join readable dst on dst.oid=k.confrelid "+
      "where (k.contype='c' and src.relname = any("+list+")) or "+
      "(k.contype='f' and dst.oid is not null and (src.relname = any("+list+") or dst.relname = any("+list+"))) order by 1,2"),
  ]);
  return {columns,constraints:links,...(ignored.length?{ignored_names:ignored}:{})};
}

export async function executeResearchTool(scope:ResearchScope,name:string,rawArguments:string):Promise<Record<string,unknown>>{
  let args:Record<string,unknown>;
  try{args=JSON.parse(rawArguments) as Record<string,unknown>;}catch{return {ok:false,error:"arguments are not valid JSON"};}
  try{
    if(name==="describe_database")
      return await describeDatabase(scope,Array.isArray(args.tables)?args.tables.map(String):null);
    if(name==="run_sql")
      return typeof args.sql==="string"&&args.sql.trim()?await runSql(scope,args.sql).then(r=>{rememberPrivate(scope,r.rows);return r;}):{ok:false,error:"sql is required"};
    if(name==="search_web"){
      if(!scope.webSearch||typeof args.query!=="string")return {ok:false,error:"web search is not available"};
      const leaked=privateTextIn(scope,args.query);
      if(leaked)return {ok:false,error:"The query contains text from your private café data (\""+leaked+"\"). Public searches must not include it; rewrite the query without it."};
      return {ok:true,result:await scope.webSearch(args.query,scope.signal)};
    }
    if(name==="remember_cafe_note"||name==="forget_cafe_note"){
      if(!scope.notes)return {ok:false,error:"café notes are not available"};
      const topic=typeof args.topic==="string"?args.topic.trim().toLowerCase():"";
      if(!/^[a-z][a-z0-9_.:-]{0,79}$/u.test(topic))return {ok:false,error:"topic must be a short lowercase key like busy_hours"};
      if(name==="forget_cafe_note")return {ok:true,forgotten:await scope.notes.forget(topic)};
      if(typeof args.note!=="string"||!args.note.trim()||typeof args.basis!=="string"||!args.basis.trim())return {ok:false,error:"note and basis are required"};
      await scope.notes.save(topic,args.note.trim().slice(0,1000),args.basis.trim().slice(0,500));
      return {ok:true,saved:topic};
    }
    if(name==="calculate")
      return executeCalculationTool(args);
    return {ok:false,error:"unknown tool "+name};
  }catch(error){
    return {ok:false,error:error instanceof Error?error.message:"tool_failed"};
  }
}
