import "server-only";
import {createHash,randomUUID} from "node:crypto";
import {Pool,type PoolClient} from "pg";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {admitU3Sql,U3AdmissionError,ownerOnlyResearchRelations,type U3TrustedUnit,type U3RelationUnits} from "./u3SqlAdmission";
import {researchPageBudget} from "../executionPolicy";
import {validateResearchConnection} from "./u3ResearchConnection";
import {researchNextCursor,researchPage,type ResearchSnapshot} from "./u3SqlCursor";

/** One research executor for the existing query_data tool.
 * No service-role client receives model-authored SQL. Scope is a server-only
 * signed capability validated by independently enforced database RLS. */
export type U3SqlContext={
 db:SupabaseClient;businessId:string;ownerUserId?:string;threadId?:string;
 mode?:"owner"|"investigation"|"durable"|"routine";aggregateOnly?:boolean;
 sourceType?:string;sourceId?:string;runId?:string;leaseToken?:string;
 resultBudgetBytes?:number;
};
// Transport/context page bounds, NEVER total query, date or evidence ceilings.
// The fetch batch bounds in-flight database rows, not the result size or model calls.
const FETCH_BATCH=32;
const QUERY_TIME_MS=8000;
const CURSOR_PREFIX="DECLARE u3_result NO SCROLL CURSOR FOR SELECT * FROM (";
const scopeSchema=z.strictObject({
 businessId:z.uuid(),ownerUserId:z.uuid(),threadId:z.uuid(),
 mode:z.enum(["owner","investigation","durable","routine"]),
 sourceType:z.string().max(100).nullable(),sourceId:z.string().max(256).nullable(),
 runId:z.uuid().nullable(),leaseToken:z.uuid().nullable()
});
export const u3SqlSchema=z.strictObject({
 sql:z.string().min(1),
 parameters:z.array(z.union([
  z.string(),z.number().finite(),z.boolean(),z.null()
 ])).nullable(),
 limit:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
 cursor:z.string().min(30).max(512).nullable().optional(),
 date_from:z.iso.date().nullable(),date_to:z.iso.date().nullable()
});
export type U3Column={name:string;type:string;nullable:boolean;unit:string};
export type U3Relationship={target:string;fields:string[];targetFields:string[];cardinality:"many_to_one"};
export type U3Relation={name:string;description:string|null;columns:U3Column[];relationships:U3Relationship[]};
const CATALOG_SQL="SELECT c.table_name AS relation, c.column_name AS column_name, "+
 "c.udt_name AS db_type, c.is_nullable AS nullable, "+
 "pg_catalog.obj_description(pc.oid,'pg_class') AS description "+
 "FROM information_schema.columns c "+
 "JOIN pg_catalog.pg_namespace pn ON pn.nspname=c.table_schema "+
 "JOIN pg_catalog.pg_class pc ON pc.relnamespace=pn.oid AND pc.relname=c.table_name "+
 "WHERE c.table_schema='u3_research' ORDER BY c.table_name,c.ordinal_position";
const RELATIONSHIPS_SQL=`
 SELECT src.relname AS source,tgt.relname AS target,
   (SELECT array_agg(a.attname ORDER BY ix.ord)
      FROM unnest(fk.conkey) WITH ORDINALITY ix(n,ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=src.oid AND a.attnum=ix.n) AS fields,
   (SELECT array_agg(a.attname ORDER BY ix.ord)
      FROM unnest(fk.confkey) WITH ORDINALITY ix(n,ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=tgt.oid AND a.attnum=ix.n) AS target_fields
 FROM pg_catalog.pg_constraint fk
 JOIN pg_catalog.pg_class src ON src.oid=fk.conrelid
 JOIN pg_catalog.pg_class tgt ON tgt.oid=fk.confrelid
 WHERE fk.contype='f' AND src.relnamespace='public'::regnamespace
   AND tgt.relnamespace='public'::regnamespace
 ORDER BY source,target,fk.conname
`;
const columnUnit=(field:string,type:string)=>{
 if(field.endsWith("_cents"))return "integer_cent";
 if(field.endsWith("_micros"))return "microcent";
 if(field.endsWith("_at"))return "timestamp_observed_or_effective";
 if(field==="business_date"||field.endsWith("_date"))return "cafe_business_date";
 if(field.endsWith("_minutes"))return "minutes";
 if(field.endsWith("_hours"))return "hours";
 if(field==="quantity"||field.endsWith("_quantity"))return "source_specific_unit";
 if(field.endsWith("_id")||field==="id")return "stable_relation_key_not_people_count";
 if(type==="bool")return "boolean";
 return "source_defined";
};

let pool:Pool|null=null;
let cachedCatalog:{until:number;relations:U3Relation[]}|null=null;
export const u3SqlConfigured=()=>process.env.AICAFE_RESEARCH_SQL_ENABLED==="true"&&
 typeof process.env.AICAFE_RESEARCH_DATABASE_URL==="string"&&
 process.env.AICAFE_RESEARCH_DATABASE_URL.length>0;
function getPool():Pool{
 if(pool)return pool;
 const raw=process.env.AICAFE_RESEARCH_DATABASE_URL;
 if(!raw)throw Error("research_not_configured");
 // Validates the database role, exact Supabase project and pooler username.
 // The transaction below separately verifies current_user is a non-BYPASSRLS
 // aicafe_research role after connecting.
 validateResearchConnection(raw,process.env.NEXT_PUBLIC_SUPABASE_URL);
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
  // Routine must present the original scheduled run and exact live lease;
  // owner-session and investigation tickets are never interchangeable.
  if(p.mode==="routine"&&(!p.runId||!p.leaseToken||p.sourceType||p.sourceId))return null;
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
async function withinScope<T>(ctx:U3SqlContext,callback:(client:PoolClient,observedAt:unknown)=>Promise<T>,
 requestedWindow?:{date_from:string|null;date_to:string|null}):Promise<T>{
 if(!u3SqlConfigured())throw Error("research_not_configured");
 // The server mints the capability only after authenticating the real owner,
 // café, original thread and durable/off-turn lease. Never log or return it.
 const ticket=await signedCapability(ctx);
 let client:PoolClient;
 try{client=await getPool().connect();}
 catch(e){if(e instanceof Error&&e.message==="research_connection_untrusted")throw e;
  throw Error("research_connection_failed");}
 let begun=false;
 try{
  // Pin and verify the actual connection that will execute this transaction,
  // including when a transaction-mode pooler is in use.
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  begun=true;
  // Static trusted SET statements share one transport, not model SQL.
  await client.query("SET LOCAL statement_timeout = '8000ms'; "+
   "SET LOCAL lock_timeout = '300ms'; SET LOCAL work_mem = '4MB'; "+
   "SET LOCAL search_path = u3_research, pg_catalog");
  const role=(await client.query(
   "SELECT current_user AS name,(SELECT rolsuper OR rolbypassrls FROM pg_roles "+
   "WHERE rolname=current_user) AS privileged")).rows[0];
  if(role?.name!=="aicafe_research"||role?.privileged!==false)
   throw Error("research_connection_untrusted");
  const from=requestedWindow?.date_from??null,to=requestedWindow?.date_to??null;
  if(from!==null&&to!==null){
   const distance=(Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))/86_400_000;
   if(!Number.isFinite(distance)||distance<0)throw Error("invalid_query");
  }else if(from!==null||to!==null)throw Error("invalid_query");
  // One parameterized trusted round trip establishes the signed scope,
  // optional date window and actual DB transaction observation timestamp.
  // Never expose the private setting values or signed capability.
  const observed=(await client.query(
   "SELECT set_config('aicafe.u3_research_scope',$1,true),"+ // hardcode-ok: PostgreSQL bind placeholder
   "set_config('aicafe.u3_date_from',$2,true),"+ // hardcode-ok: PostgreSQL bind placeholder
   "set_config('aicafe.u3_date_to',$3,true),transaction_timestamp() AS observed_at", // hardcode-ok: PostgreSQL bind placeholder
   [ticket,from??"",to??""])).rows[0]?.observed_at;
  const result=await callback(client,observed);
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
    columns:[],relationships:[]};
   byName.set(row.relation,relation);
  }
  relation.columns.push({name:row.column_name,
   type:String(row.db_type??"unknown"),nullable:row.nullable==="YES",
   unit:columnUnit(row.column_name,String(row.db_type??"unknown"))});
 }
 // A structural FK is discoverable but NEVER proves compatible grain,
 // actual source freshness, customer identity, or causal attribution.
 const edges=await client.query(RELATIONSHIPS_SQL);
 for(const edge of edges.rows){
  const source=byName.get(String(edge.source));
  if(!source||!byName.has(String(edge.target))||
   !Array.isArray(edge.fields)||!Array.isArray(edge.target_fields))continue;
  source.relationships.push({target:String(edge.target),fields:edge.fields,
   targetFields:edge.target_fields,cardinality:"many_to_one"});
 }
 const result=[...byName.values()];
 // Cache only the authorized logical schema, never café data or answers.
 cachedCatalog={until:Date.now()+45000,relations:result};
 return result;
}
/** Catalog metadata is finite, approved schema information, not raw rows.
 * Unqualified discovery lists all available relation names. A relation match
 * returns its full schema by default, as a general database connector does;
 * explicit paging remains a choice for unusually large catalogs. */
export function selectU3Catalog(all:readonly U3Relation[],p:{
 search?:string|null;relation?:string|null;offset?:number|null;limit?:number|null
},availableBytes=researchPageBudget()){
 const term=p.search?.trim().toLocaleLowerCase("en")||null;
 const relationMatch=(r:U3Relation)=>term!==null&&(r.name.toLocaleLowerCase("en").includes(term)||
  (r.description??"").toLocaleLowerCase("en").includes(term));
 const fieldMatch=(c:U3Column)=>term!==null&&(c.name.toLocaleLowerCase("en").includes(term)||
  c.unit.toLocaleLowerCase("en").includes(term));
 const available=all.filter(r=>(!p.relation||r.name===p.relation)&&
  (p.relation||term===null||relationMatch(r)||r.columns.some(fieldMatch)));
 const offset=p.offset??0,detail=Boolean(p.relation);
 const total=detail?(available[0]?.columns.length??0):available.length;
 const limit=p.limit??Math.max(0,total-offset);
 const matching=detail?available:available.slice(offset,offset+limit);
 const relations=matching.map(r=>{
  const fields=detail||relationMatch(r)?r.columns:term===null?[]:r.columns.filter(fieldMatch);
  return {name:r.name,meaning:r.description??"Reviewed logical source; consult field definitions.",
   relationships:r.relationships,columns:detail?fields.slice(offset,offset+limit):fields,
   columnCount:r.columns.length,fieldsTotal:detail?fields.length:undefined};
 });
 const version=createHash("sha256").update(JSON.stringify(all)).digest("hex").slice(0,16);
 const budget=Math.max(0,Math.min(availableBytes,researchPageBudget()));
 let count=detail?(relations[0]?.columns.length??0):relations.length;
 const build=()=>{
  const next=offset+count<total?offset+count:null;
  return {source:"u3_semantic_catalog",period:null,
   missing:available.length?(next!==null?["result_truncated"]:[]):["empty"],relations,
   total:available.length,fields_total:detail?total:undefined,page_offset:offset,
   next_offset:next,truncated:next!==null,catalog_version:version};
 };
 while(count>0&&Buffer.byteLength(JSON.stringify(build()),"utf8")>budget){
  if(detail)relations[0].columns.pop();
  else relations.pop();
  count--;
 }
 if(count===0&&offset<total)return {...build(),relations:[],next_offset:null,
  truncated:true,missing:["row_exceeds_page_budget"]};
 return build();
}
export async function describeU3Catalog(ctx:U3SqlContext,p:{
 search?:string|null;relation?:string|null;offset?:number|null;limit?:number|null
}){
 return withinScope(ctx,async client=>{
  const all=await sources(client);
  const aggregateOnly=ctx.aggregateOnly===true||ctx.mode==="routine"||ctx.mode==="investigation";
  const visible=aggregateOnly?all.filter(r=>!ownerOnlyResearchRelations.has(r.name)):all;
  return selectU3Catalog(visible,p,ctx.resultBudgetBytes);
 });
}
/** Protect the legacy retained-data archive from nested-object extraction,
 * including objects serialized by PostgreSQL as text. */
export function unsafeStructuredToastResult(rows:readonly unknown[]):boolean{
 return rows.some(row=>{
  if(!row||typeof row!=="object"||Array.isArray(row))return true;
  return Object.values(row).some(value=>{
   if(value===null||value instanceof Date)return false;
   if(typeof value==="object")return true;
   if(typeof value!=="string")return false;
   const trimmed=value.trim();
   if(!trimmed.startsWith("{")&&!trimmed.startsWith("["))return false;
   try{
    const decoded=JSON.parse(trimmed) as unknown;
    return decoded!==null&&typeof decoded==="object";
   }catch{return false;}
  });
 });
}

/** Stream the complete result in one repeatable-read transaction. Hash every
 * serialized row in its actual order, retaining only the requested page in
 * memory. Subsequent pages must match this exact ordered result before any
 * rows are returned. No unbounded process cache or persistent raw-data copy.
 * The real wall-clock/statement resource budget applies to the full scan. */
async function readResearchPage(client:PoolClient,sql:string,parameters:readonly unknown[],
 offset:number,limit:number|null,resultBudgetBytes:number,validate:(rows:unknown[])=>void){
 const started=Date.now();
 await client.query({text:CURSOR_PREFIX+sql+") AS u3_bounded",values:[...parameters]});
 const rows:unknown[]=[];let bytes=2,totalRows=0,pageFull=false;
 const digest=createHash("sha256");
 while(true){
  const remaining=QUERY_TIME_MS-(Date.now()-started);
  if(remaining<=0)throw Error("query_timeout");
  await client.query("SELECT set_config('statement_timeout',$1,true)",[String(remaining)]); // hardcode-ok: PostgreSQL bind placeholder
  const result=await client.query("FETCH FORWARD "+FETCH_BATCH+" FROM u3_result");
  const batch:unknown[]=result.rows;
  if(new Set(result.fields.map(field=>field.name)).size!==result.fields.length)
   throw Error("duplicate_result_columns");
  validate(batch);
  for(const row of batch){
   const serialized=JSON.stringify(row);
   const size=Buffer.byteLength(serialized,"utf8");
   // Length prefix makes the byte stream unambiguous across row boundaries.
   digest.update(String(size)+":").update(serialized);
   const index=totalRows++;
   if(index<offset||pageFull)continue;
   if((limit!==null&&rows.length===limit)||bytes+size+(rows.length?1:0)>resultBudgetBytes){
    pageFull=true;continue;
   }
   rows.push(row);bytes+=size+(rows.length>1?1:0);
  }
  if(batch.length<FETCH_BATCH)break;
 }
 if(Date.now()-started>QUERY_TIME_MS)throw Error("query_timeout");
 return {rows,totalRows,digest:digest.digest("hex"),truncated:offset+rows.length<totalRows};
}
// Only fixed error categories and SQLSTATE values are returned to the model.
// Raw database messages can contain source values, credentials or internal
// schema names. Never forward them (or log them) to gain recoverability.
const queryDiagnosticReasons:Readonly<Record<string,string>>=Object.freeze({
 "42601":"sql_syntax","42703":"undefined_column","42P01":"undefined_relation",
 "42883":"undefined_function_or_operator","42804":"datatype_mismatch",
 "42803":"grouping_error","42P10":"invalid_column_reference","22P02":"invalid_literal",
 "22012":"division_by_zero","22003":"numeric_out_of_range","57014":"statement_timeout",
 "42501":"permission_denied"
});
export function safeU3SqlDiagnostic(e:unknown,sqlLength:number){
 if(e instanceof U3AdmissionError)return {reason:e.reason};
 if(!e||typeof e!=="object"||!("code" in e)||typeof e.code!=="string"||
   !Object.hasOwn(queryDiagnosticReasons,e.code))return undefined;
 // PostgreSQL positions refer to the actual submitted SELECT wrapper.
 // Only include an offset that maps into the model's own query text.
 const position="position" in e&&typeof e.position==="string"&&/^\d+$/.test(e.position)?
  Number(e.position)-CURSOR_PREFIX.length:NaN;
 return {sqlstate:e.code,reason:queryDiagnosticReasons[e.code],
  ...(Number.isSafeInteger(position)&&position>=1&&position<=sqlLength?{query_position:position}:{})};
}
export function safeU3SqlErrorCode(e:unknown){
 const s=e instanceof Error?e.message:"";
 if(e&&typeof e==="object"&&"code" in e&&typeof e.code==="string"){
  if(e.code==="57014")return "query_timeout";
  if(e.code==="42501")return "research_scope_denied";
  if(["42601","42703","42P01","42883","42804","42803","42P10","22P02"].includes(e.code))
    return "query_syntax_error";
  if(["22012","22003"].includes(e.code))return "query_execution_error";
 }
 return ["invalid_query","unattended_aggregate_required","research_invalid_scope",
  "research_not_configured","research_scope_denied",
  "research_connection_untrusted","research_connection_failed","query_timeout",
  "row_exceeds_page_budget","duplicate_result_columns","research_context_exhausted","stable_order_required","research_snapshot_changed",
  "query_syntax_error","query_execution_error"].includes(s)?s:"source_read_failed";
}
/** Model SQL can use joins, windows, CTEs and nested analytics, but only on
 * the RLS-protected admitted logical research sources. No raw SQL text, model
 * arguments, DB errors or owner IDs are ever returned as tool evidence. */
export async function runU3Sql(ctx:U3SqlContext,raw:unknown){
 const startedAt=Date.now();
 const stage:{value:"scope"|"catalog"|"admission"|"query"|"result"}={value:"scope"};
 const parsed=u3SqlSchema.safeParse(raw);
 if(!parsed.success)return {source:"u3_canonical_research",period:null,
  missing:["invalid_query"],rows:[],truncated:false};
 try{
  const resultBudgetBytes=Math.min(researchPageBudget(),ctx.resultBudgetBytes??researchPageBudget());
  if(!Number.isSafeInteger(resultBudgetBytes)||resultBudgetBytes<2)throw Error("research_context_exhausted");
  stage.value="admission";
  if(Buffer.byteLength(JSON.stringify(parsed.data.parameters??[]),"utf8")>256*1024)throw new U3AdmissionError("parser_resource_bound");
  const committedPage=await withinScope(ctx,async (client,asOf)=>{
   stage.value="catalog";
   const list=await sources(client);
   if(!list.length)throw Error("research_not_configured");
   const p=parsed.data;
   // Off-turn privacy is source/field-based, not a regex over model-
   // selected output aliases. These are reusable data classes rather than
   // question patterns; personal IDs, text and unrestricted JSON are excluded.
   const aggregateOnly=ctx.aggregateOnly===true||ctx.mode==="routine"||ctx.mode==="investigation";
   const safeOffturnColumns=new Set(list.flatMap(r=>
    ownerOnlyResearchRelations.has(r.name)?[]:
    r.columns.filter(c=>
     c.unit==="integer_cent"||c.unit==="microcent"||
     c.unit==="cafe_business_date"||c.unit==="minutes"||c.unit==="hours"||
     c.unit==="source_specific_unit"||c.unit==="boolean"||
     ["int2","int4","int8","numeric","float4","float8","bool","date"].includes(c.type)&&
       !/(?:_id|_ref|_guid|^id$|^phone|^postal)/i.test(c.name)||
     ["status","category","source","source_channel","dining_option",
      "toast_excluded","sales_data_status"].includes(c.name)
    ).map(c=>c.name)));
   // Exact calculator units come from the authorized catalog and parsed SQL
   // projection, never an arbitrary alias such as "net_sales_cents".
   const knownColumnUnits:Record<string,U3TrustedUnit|null>={};
   const relationUnits:Record<string,Record<string,U3TrustedUnit|null>>={};
   for(const relation of list)for(const col of relation.columns){
    const unit:U3TrustedUnit|null=col.unit==="integer_cent"?"cents":
     col.unit==="microcent"?"microcents":
     /(?:^|_)(?:count|orders|items|visits|rows)$/.test(col.name)&&
       ["int2","int4","int8","numeric"].includes(col.type)?"count":
     /(?:^|_)percent$/.test(col.name)?"percent":
     /(?:^|_)(?:ratio|share|margin)$/.test(col.name)?"ratio":null;
    (relationUnits[relation.name]??={})[col.name]=unit;
    if(Object.hasOwn(knownColumnUnits,col.name)&&knownColumnUnits[col.name]!==unit)
     knownColumnUnits[col.name]=null;
    else if(!Object.hasOwn(knownColumnUnits,col.name))
     knownColumnUnits[col.name]=unit;
   }
   stage.value="admission";
   const plan=await admitU3Sql(p.sql,list.map(r=>r.name),p.parameters?.length??0,
    aggregateOnly,[...safeOffturnColumns],knownColumnUnits,relationUnits satisfies U3RelationUnits);
   const customerEvidence=plan.relations.some(relation=>["customer_visits","customer_products","customer_coverage"].includes(relation));
   if((customerEvidence||plan.relations.some(relation=>relation==="toast_records"||relation==="toast_changes"))&&
     (p.date_from===null||p.date_to===null))throw Error("invalid_query");
   // Each page revalidates the signed owner/café/thread/lease in PostgreSQL.
   // The opaque cursor protects the exact SQL/parameters/window/scope from
   // substitution. Pagination is applied AFTER the full owner-chosen SELECT,
   // never inside a CTE/join/window where it could change the answer.
   const count=p.limit;
   const cursorInput={
    businessId:ctx.businessId,ownerUserId:ctx.ownerUserId??"",
    threadId:ctx.threadId??"",mode:ctx.mode??"owner",
    sourceType:ctx.sourceType??null,sourceId:ctx.sourceId??null,
    runId:ctx.runId??null,leaseToken:ctx.leaseToken??null,aggregateOnly,
    sql:p.sql,parameters:p.parameters??null,date_from:p.date_from,
    date_to:p.date_to,limit:count
   };
   const key=process.env.SUPABASE_SERVICE_ROLE_KEY??"";
   const {offset,snapshot:prior}=researchPage(cursorInput,p.cursor,key);
   const bounded=p.sql.trim().replace(/;\s*$/,"");
   const parameters=p.parameters??[];
   stage.value="query";
   // PostgreSQL cost is a dimensionless estimate, not elapsed time or a
   // physical resource limit. Planning twice and rejecting by an arbitrary
   // cost number blocks legitimate indexed/aggregate work. The actual query
   // is still bounded by the same server statement/lock timeout, work_mem,
   // admitted AST, isolated role, pool limit and result transport.
   const fit=await readResearchPage(client,bounded,parameters,offset,count,resultBudgetBytes,rows=>{
    if(plan.relations.includes("toast_records")&&unsafeStructuredToastResult(rows))
     throw Error("invalid_query");
    if(aggregateOnly&&rows.some(row=>
     !row||typeof row!=="object"||Array.isArray(row)||
     Object.entries(row).some(([key,value])=>
      /name|email|phone|address|employee|customer|person|account|identity|recipient/i.test(key)&&value!==null&&
      // A count or amount with an attested numeric SQL lineage cannot become
      // private text merely because the model labels it customer_count.
      !(Object.hasOwn(plan.outputUnits,key)&&
       (typeof value==="number"&&Number.isFinite(value)||
        typeof value==="string"&&/^[+-]?\d+(?:\.\d+)?$/u.test(value))))))
     throw Error("unattended_aggregate_required");
   });
   stage.value="result";
   // Independent unfiltered denominator from the same scoped DB snapshot.
   const rawCoverage=customerEvidence?(await client.query(
    "SELECT eligible_check_count,linked_check_count,named_check_count,known_money_check_count,"+
    "linked_known_money_check_count,recorded_net_cents,linked_recorded_net_cents,"+
    "expected_location_days,complete_location_days,complete FROM u3_research.customer_coverage"
   )).rows[0]:undefined;
   const integer=(value:unknown):number|null=>{
    if(value===null||value===undefined)return null;
    const n=Number(value);return Number.isSafeInteger(n)?n:null;
   };
   const candidateCoverage=rawCoverage?{
    scope:"all_eligible_checks_in_period" as const,
    eligibleChecks:integer(rawCoverage.eligible_check_count),
    linkedChecks:integer(rawCoverage.linked_check_count),
    namedChecks:integer(rawCoverage.named_check_count),
    knownMoneyChecks:integer(rawCoverage.known_money_check_count),
    linkedKnownMoneyChecks:integer(rawCoverage.linked_known_money_check_count),
    recordedNetCents:integer(rawCoverage.recorded_net_cents),
    linkedRecordedNetCents:integer(rawCoverage.linked_recorded_net_cents),
    expectedLocationDays:integer(rawCoverage.expected_location_days),
    completeLocationDays:integer(rawCoverage.complete_location_days),
    complete:rawCoverage.complete===true
   }:undefined;
   // Invalid counts are unavailable, never invented zeroes.
   const natural=(n:number|null):n is number=>n!==null&&n>=0;
   const c=candidateCoverage;
   const customerCoverage=c&&natural(c.eligibleChecks)&&natural(c.linkedChecks)&&
    natural(c.namedChecks)&&natural(c.knownMoneyChecks)&&natural(c.linkedKnownMoneyChecks)&&
    natural(c.expectedLocationDays)&&natural(c.completeLocationDays)&&
    c.linkedChecks<=c.eligibleChecks&&c.namedChecks<=c.eligibleChecks&&
    c.knownMoneyChecks<=c.eligibleChecks&&c.linkedKnownMoneyChecks<=c.linkedChecks&&
    c.completeLocationDays<=c.expectedLocationDays?
    {...c,eligibleChecks:c.eligibleChecks,linkedChecks:c.linkedChecks,namedChecks:c.namedChecks,
     knownMoneyChecks:c.knownMoneyChecks,linkedKnownMoneyChecks:c.linkedKnownMoneyChecks,
     expectedLocationDays:c.expectedLocationDays,completeLocationDays:c.completeLocationDays}:undefined;
   const digest=customerEvidence?createHash("sha256").update(fit.digest)
    .update(JSON.stringify(customerCoverage??null)).digest("hex"):fit.digest;
   if(prior&&(prior.digest!==digest||prior.totalRows!==fit.totalRows))
    throw Error("research_snapshot_changed");
   const snapshot:ResearchSnapshot=prior??{id:randomUUID(),digest,totalRows:fit.totalRows,
    asOf:asOf instanceof Date?asOf.toISOString():String(asOf??"")};
   const truncated=fit.truncated;
   // A single oversized source row must not cause a cursor loop that never
   // advances or an apparently complete empty business observation.
   if(truncated&&fit.rows.length===0)throw Error("row_exceeds_page_budget");
   const nextOffset=offset+fit.rows.length;
   if(!Number.isSafeInteger(nextOffset))throw Error("invalid_query");
   const nextCursor=truncated?researchNextCursor(cursorInput,nextOffset,key,snapshot):null;
   return {source:"u3_canonical_research",
    period:customerEvidence&&p.date_from&&p.date_to?{from:p.date_from,to:p.date_to}:null,
    missing:[...(truncated?["result_truncated"]:[]),
     ...(customerEvidence&&!customerCoverage?.complete?["customer_source_coverage_incomplete"]:[])],rows:fit.rows,
    customerEvidence,customerCoverage,aggregateOnly,
    rowCount:fit.rows.length,truncated,
    page_offset:offset,next_cursor:nextCursor,page_complete:!truncated,
    // Exact full-result equivalence is proved on every page; this is not
    // a long-lived exported PostgreSQL MVCC transaction.
    page_consistency:"verified_same_result",total_rows:fit.totalRows,
    evidence:{receipt_id:randomUUID(),snapshot_id:snapshot.id,
     snapshot_digest:snapshot.digest,as_of:snapshot.asOf,
     query_fingerprint:createHash("sha256").update(p.sql).digest("hex"),
     column_units:plan.outputUnits,column_origins:plan.outputOrigins,
     catalog_version:createHash("sha256").update(JSON.stringify(list)).digest("hex").slice(0,16),
     relation_names:plan.relations,functions:plan.functions,
     authority:"approved_logical_source",scope:"verified_owner_cafe_lease"}
   };
  },{date_from:parsed.data.date_from,date_to:parsed.data.date_to});
  // Record only a committed, validated result (never raw café/owner/SQL
  // values). Correlate the safe returned receipt with execution telemetry.
  console.info("u3_sql_research_receipt",{
   receipt_id:committedPage.evidence.receipt_id,
   duration_ms:Math.max(0,Date.now()-startedAt),
   relation_count:committedPage.evidence.relation_names.length,
   page_complete:committedPage.page_complete
  });
  return committedPage;
 }catch(e){
  const code=safeU3SqlErrorCode(e);
  // Structured operational telemetry is deliberately limited to finite safe
  // reason/stage labels. Never log the SQL, bind values, café, owner, ticket,
  // private connection error, source row, or raw provider diagnostic.
  const safeStage=code==="research_connection_untrusted"||code==="research_connection_failed"?
   "connection":code==="research_scope_denied"?"scope":stage.value;
  if(code!=="invalid_query")console.warn("u3_sql_research_failure",{
   code,stage:safeStage,configured:u3SqlConfigured()
  });
  return {source:"u3_canonical_research",period:null,missing:[code],
   error_stage:safeStage,
   ...(safeStage==="query"||safeStage==="admission"?{diagnostic:safeU3SqlDiagnostic(e,parsed.data.sql.trim().replace(/;\s*$/,"").length)}:{}),
   rows:[],rowCount:0,truncated:false,
   page_complete:false,next_cursor:null};
 }
}
