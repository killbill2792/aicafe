import "server-only";
import {createHash,randomUUID} from "node:crypto";
import {Pool,type PoolClient} from "pg";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {admitU3Sql} from "./u3SqlAdmission";

/** One research executor for the existing query_data tool.
 * No service-role client receives model-authored SQL. Scope is a server-only
 * signed capability validated by independently enforced database RLS. */
export type U3SqlContext={
 db:SupabaseClient;businessId:string;ownerUserId?:string;threadId?:string;
 mode?:"owner"|"investigation"|"durable";aggregateOnly?:boolean;
 sourceType?:string;sourceId?:string;runId?:string;leaseToken?:string;
};
const MAX_ROWS=100,MAX_RESULT_CHARS=6000,MAX_SQL_CHARS=12000;
const scopeSchema=z.strictObject({
 businessId:z.uuid(),ownerUserId:z.uuid(),threadId:z.uuid(),
 mode:z.enum(["owner","investigation","durable"]),
 sourceType:z.string().max(100).nullable(),sourceId:z.string().max(256).nullable(),
 runId:z.uuid().nullable(),leaseToken:z.uuid().nullable()
});
export const u3SqlSchema=z.strictObject({
 sql:z.string().min(1).max(MAX_SQL_CHARS),
 parameters:z.array(z.union([
  z.string().max(512),z.number().finite(),z.boolean(),z.null()
 ])).max(48).nullable(),
 limit:z.number().int().min(1).max(MAX_ROWS).nullable()
});
export type U3Column={name:string;type:string;nullable:boolean};
export type U3Relation={name:string;description:string|null;columns:U3Column[]};
const CATALOG_SQL="SELECT c.table_name AS relation, c.column_name AS column_name, "+
 "c.udt_name AS db_type, c.is_nullable AS nullable, "+
 "pg_catalog.obj_description(pc.oid,'pg_class') AS description "+
 "FROM information_schema.columns c "+
 "JOIN pg_catalog.pg_namespace pn ON pn.nspname=c.table_schema "+
 "JOIN pg_catalog.pg_class pc ON pc.relnamespace=pn.oid AND pc.relname=c.table_name "+
 "WHERE c.table_schema='u3_research' ORDER BY c.table_name,c.ordinal_position";

let pool:Pool|null=null;
let cachedCatalog:{until:number;relations:U3Relation[]}|null=null;
export const u3SqlConfigured=()=>process.env.AICAFE_RESEARCH_SQL_ENABLED==="true"&&
 typeof process.env.AICAFE_RESEARCH_DATABASE_URL==="string"&&
 process.env.AICAFE_RESEARCH_DATABASE_URL.length>0;
function getPool():Pool{
 if(pool)return pool;
 const raw=process.env.AICAFE_RESEARCH_DATABASE_URL;
 if(!raw)throw Error("research_not_configured");
 let url:URL;
 try{url=new URL(raw);}catch{throw Error("research_connection_untrusted");}
 if(!["postgres:","postgresql:"].includes(url.protocol)||
  decodeURIComponent(url.username)!=="aicafe_research"||
  !url.hostname||!url.pathname||url.pathname==="/")
  throw Error("research_connection_untrusted");
 pool=new Pool({connectionString:raw,max:2,connectionTimeoutMillis:4000,
  idleTimeoutMillis:5000,allowExitOnIdle:true,
  application_name:"aicafe-u3-research"});
 pool.on("error",()=>{/* node-pg discards failed idle connections. */});
 return pool;
}
function scope(ctx:U3SqlContext){
 const parsed=scopeSchema.safeParse({
  businessId:ctx.businessId,ownerUserId:ctx.ownerUserId,threadId:ctx.threadId,
  mode:ctx.mode??"owner",sourceType:ctx.sourceType??null,
  sourceId:ctx.sourceId??null,runId:ctx.runId??null,
  leaseToken:ctx.leaseToken??null
 });
 if(!parsed.success)return null;
 const p=parsed.data;
 if(p.mode==="owner"&&(p.sourceType||p.sourceId||p.runId||p.leaseToken))return null;
 if(p.mode==="investigation"&&(!p.sourceType||!p.sourceId||!p.leaseToken))return null;
 if(p.mode==="durable"&&(!p.runId||!p.leaseToken))return null;
 return p;
}
async function signedCapability(ctx:U3SqlContext):Promise<string>{
 const p=scope(ctx);
 if(!p||!ctx.db)throw Error("research_invalid_scope");
 // A checked owner/thread/lease comes only from trusted server contexts.
 // Mint through the internal service client: browser RLS clients cannot call
 // this service-only RPC, and model SQL never sees the privileged client.
 const {data,error}=await createAdminSupabaseClient().rpc("u3_issue_research_scope",{
  p_business_id:p.businessId,p_owner_user_id:p.ownerUserId,p_thread_id:p.threadId,
  p_mode:p.mode,p_source_type:p.sourceType,p_source_id:p.sourceId,
  p_run_id:p.runId,p_lease_token:p.leaseToken
 });
 if(error||typeof data!=="string"||data.length<75||data.length>4096)
  throw Error("research_scope_denied");
 return data;
}
async function withinScope<T>(ctx:U3SqlContext,callback:(client:PoolClient)=>Promise<T>):Promise<T>{
 if(!u3SqlConfigured())throw Error("research_not_configured");
 // The server mints the capability only after authenticating the real owner,
 // café, original thread and durable/off-turn lease. Never log or return it.
 const ticket=await signedCapability(ctx);
 const client=await getPool().connect();
 let begun=false;
 try{
  const role=(await client.query(
   "SELECT current_user AS name,(SELECT rolsuper OR rolbypassrls FROM pg_roles "+
   "WHERE rolname=current_user) AS privileged")).rows[0];
  if(role?.name!=="aicafe_research"||role?.privileged!==false)
   throw Error("research_connection_untrusted");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  begun=true;
  await client.query("SET LOCAL statement_timeout = '8000ms'");
  await client.query("SET LOCAL lock_timeout = '300ms'");
  await client.query("SET LOCAL work_mem = '4MB'");
  await client.query("SET LOCAL search_path = u3_research, pg_catalog");
  // Trusted application operation, NEVER a model-authored SQL call.
  await client.query("SELECT set_config('aicafe.u3_research_scope',$1,true)",[ticket]);
  const result=await callback(client);
  await client.query("COMMIT");
  begun=false;
  return result;
 }catch(e){
  if(begun)await client.query("ROLLBACK").catch(()=>{});
  throw e;
 }finally{client.release();}
}
async function sources(client:PoolClient):Promise<U3Relation[]>{
 if(cachedCatalog&&cachedCatalog.until>Date.now())return cachedCatalog.relations;
 const {rows}=await client.query(CATALOG_SQL);
 const byName=new Map<string,U3Relation>();
 for(const row of rows){
  if(typeof row.relation!=="string"||typeof row.column_name!=="string")continue;
  let relation=byName.get(row.relation);
  if(!relation){
   relation={name:row.relation,
    description:typeof row.description==="string"?row.description:null,
    columns:[]};
   byName.set(row.relation,relation);
  }
  relation.columns.push({name:row.column_name,
   type:String(row.db_type??"unknown"),nullable:row.nullable==="YES"});
 }
 const result=[...byName.values()];
 // Cache only the authorized logical schema, never café data or answers.
 cachedCatalog={until:Date.now()+45000,relations:result};
 return result;
}
export async function describeU3Catalog(ctx:U3SqlContext,p:{
 search?:string|null;relation?:string|null;offset?:number|null;limit?:number|null
}){
 return withinScope(ctx,async client=>{
  const all=await sources(client);
  const term=p.search?.trim().toLocaleLowerCase("en")??null;
  const available=all.filter(r=>(!p.relation||r.name===p.relation)&&(
   term===null||r.name.toLocaleLowerCase("en").includes(term)||
   (r.description??"").toLocaleLowerCase("en").includes(term)||
   r.columns.some(c=>c.name.toLocaleLowerCase("en").includes(term))));
  const offset=p.offset??0,limit=Math.min(p.limit??20,30);
  const detail=p.relation!==null&&p.relation!==undefined;
  // For a named relation, paginate its FIELDS rather than just the one
  // relation row. Otherwise deeper admitted columns remain unreachable.
  const matching=detail?available:available.slice(offset,offset+limit);
  const out=matching.map(r=>{
   const fields=detail?r.columns:(term!==null?
    r.columns.filter(c=>c.name.toLocaleLowerCase("en").includes(term)):[]);
   return {name:r.name,
    meaning:r.description??"Reviewed logical source; consult field definitions.",
    columns:detail?fields.slice(offset,offset+limit):fields.slice(0,12),
    columnCount:r.columns.length,
    fieldsTotal:detail?fields.length:undefined};
  });
  const total=detail?(available[0]?.columns.length??0):available.length;
  return {source:"u3_semantic_catalog",period:null,
   missing:available.length?[]:["empty"],relations:out,
   total:available.length,fields_total:detail?total:undefined,page_offset:offset,
   next_offset:offset+limit<total?offset+limit:null,
   catalog_version:createHash("sha256").update(JSON.stringify(all)).digest("hex").slice(0,16)
  };
 });
}
const fitRows=(rows:unknown[])=>{
 const kept:unknown[]=[];let bytes=2;
 for(const row of rows){
  const str=JSON.stringify(row);
  if(!str)continue;
  bytes+=str.length+1;
  if(bytes>MAX_RESULT_CHARS)return {rows:kept,cut:true};
  kept.push(row);
 }
 return {rows:kept,cut:false};
};
function safeCode(e:unknown){
 const s=e instanceof Error?e.message:"";
 return ["invalid_query","unattended_aggregate_required","research_invalid_scope",
  "research_not_configured","research_scope_denied",
  "research_connection_untrusted"].includes(s)?s:"source_read_failed";
}
/** Model SQL can use joins, windows, CTEs and nested analytics, but only on
 * the RLS-protected admitted logical research sources. No raw SQL text, model
 * arguments, DB errors or owner IDs are ever returned as tool evidence. */
export async function runU3Sql(ctx:U3SqlContext,raw:unknown){
 const parsed=u3SqlSchema.safeParse(raw);
 if(!parsed.success)return {source:"u3_canonical_research",period:null,
  missing:["invalid_query"],rows:[],truncated:false};
 try{
  return await withinScope(ctx,async client=>{
   const list=await sources(client);
   if(!list.length)throw Error("research_not_configured");
   const p=parsed.data;
   const plan=await admitU3Sql(p.sql,list.map(r=>r.name),p.parameters?.length??0,
    ctx.aggregateOnly===true);
   const count=p.limit??50;
   const bounded=p.sql.trim().replace(/;\s*$/,"");
   const statement="SELECT * FROM ("+bounded+") AS u3_bounded LIMIT "+(count+1);
   const parameters=p.parameters??[];
   const explained=await client.query({text:"EXPLAIN (FORMAT JSON) "+statement,values:parameters});
   const planJson=explained.rows[0]?.["QUERY PLAN"];
   const totalCost=Array.isArray(planJson)?planJson[0]?.Plan?.["Total Cost"]:null;
   if(typeof totalCost==="number"&&totalCost>2500000)throw Error("invalid_query");
   const asOf=(await client.query("SELECT transaction_timestamp() AS observed_at")).rows[0]?.observed_at;
   const result=await client.query({text:statement,values:parameters});
   const rows=Array.isArray(result.rows)?result.rows:[];
   const fit=fitRows(rows.slice(0,count));
   const truncated=rows.length>count||fit.cut;
   if(ctx.aggregateOnly&&fit.rows.some(row=>
    !row||typeof row!=="object"||Array.isArray(row)||
    Object.entries(row).some(([key,value])=>
      /name|email|phone|address|employee|customer|person|account|identity|recipient/i.test(key)
      &&value!==null)))
    throw Error("unattended_aggregate_required");
   return {source:"u3_canonical_research",period:null,
    missing:truncated?["result_truncated"]:[],rows:fit.rows,
    rowCount:fit.rows.length,truncated,
    evidence:{receipt_id:randomUUID(),
     as_of:asOf instanceof Date?asOf.toISOString():String(asOf??""),
     query_fingerprint:createHash("sha256").update(p.sql).digest("hex"),
     catalog_version:createHash("sha256").update(JSON.stringify(list)).digest("hex").slice(0,16),
     relation_names:plan.relations,functions:plan.functions,
     authority:"approved_logical_source",scope:"verified_owner_cafe_lease"}
   };
  });
 }catch(e){
  const code=safeCode(e);
  return {source:"u3_canonical_research",period:null,missing:[code],
   rows:[],rowCount:0,truncated:false};
 }
}
