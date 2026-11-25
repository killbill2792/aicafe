import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {CALC_OPS,exactDecimal,runCalculation,type CalcOp,type CalcUnit,type CalcValue} from "@/lib/metrics/core/calculator";

/** Supervisor SQL research tools: describe_database, run_sql (one read-only SELECT run by the database
 * function `supervisor_research_sql` as the verified owner under RLS, one café) and calculate (existing
 * exact calculator). Security is enforced in the database; no business logic here. */

export type ResearchScope={db:SupabaseClient;businessId:string;ownerUserId:string};

const UNITS=["cents","count","percent","ratio"] as const;
export const researchToolDefinitions=[
  {type:"function",name:"describe_database",strict:true,
    description:"Discover the café database you can read. With tables=null: every readable table and view with its description and columns. "+
      "With table names: each column's type, nullability and description, allowed values (check constraints), and foreign keys to and from those tables.",
    parameters:{type:"object",additionalProperties:false,required:["tables"],properties:{
      tables:{type:["array","null"],items:{type:"string"},description:"Table or view names, or null for the full list."}}}},
  {type:"function",name:"run_sql",strict:true,
    description:"Run one read-only PostgreSQL SELECT (WITH, joins, window functions, aggregates and subqueries are fine) on this café's data. "+
      "Rows are already limited to this café by the database. Returns every row the query produces. "+
      "On an error you get PostgreSQL's message; fix the SQL and try again.",
    parameters:{type:"object",additionalProperties:false,required:["sql"],properties:{
      sql:{type:"string",description:"A single SELECT statement."}}}},
  {type:"function",name:"calculate",strict:true,
    description:"Exact arithmetic on numbers you retrieved. Inputs are decimal strings with a unit: cents (money in minor units), count, "+
      "percent (\"12.5\" means 12.5%) or ratio. Steps run in order; each step's args name inputs or earlier steps. "+
      "Ops: add, subtract (2 args), multiply, divide (2 args), sum (any number), percent_of (percent × value).",
    parameters:{type:"object",additionalProperties:false,required:["inputs","steps"],properties:{
      inputs:{type:"array",items:{type:"object",additionalProperties:false,required:["name","value","unit"],properties:{
        name:{type:"string"},value:{type:"string"},unit:{type:"string",enum:[...UNITS]}}}},
      steps:{type:"array",items:{type:"object",additionalProperties:false,required:["id","op","args"],properties:{
        id:{type:"string"},op:{type:"string",enum:[...CALC_OPS]},args:{type:"array",items:{type:"string"}}}}}}}},
] as const;

async function callDatabase(scope:ResearchScope,sql:string):Promise<Record<string,unknown>>{
  const {data,error}=await scope.db.rpc("supervisor_research_sql",{
    p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_sql:sql});
  if(error)return {ok:false,error:error.message};
  return data&&typeof data==="object"?data as Record<string,unknown>:{ok:false,error:"empty_database_response"};
}

/** The database function enforces one read-only SELECT and returns PostgreSQL's own errors. */
export async function runSql(scope:ResearchScope,sql:string):Promise<Record<string,unknown>>{
  return callDatabase(scope,sql);
}

const IDENT=/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const RELATIONS="from pg_class c join pg_namespace n on n.oid=c.relnamespace "+
  "where n.nspname='public' and c.relkind in ('r','p','v','m') and has_table_privilege(c.oid,'select')";
export async function describeDatabase(scope:ResearchScope,tables:readonly string[]|null):Promise<Record<string,unknown>>{
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
      "where n.nspname='public' and c.relname = any("+list+") and has_table_privilege(c.oid,'select') "+
      "and a.attnum>0 and not a.attisdropped order by c.relname, a.attnum"),
    callDatabase(scope,"select case k.contype when 'f' then 'foreign_key' else 'allowed_values' end as kind, "+
      "k.conrelid::regclass::text as table, nullif(k.confrelid,0)::regclass::text as references, pg_get_constraintdef(k.oid) as definition "+
      "from pg_constraint k where (k.contype='c' and k.conrelid::regclass::text = any("+list+")) or (k.contype='f' and "+
      "(k.conrelid::regclass::text = any("+list+") or k.confrelid::regclass::text = any("+list+"))) order by 1,2"),
  ]);
  return {columns,constraints:links,...(ignored.length?{ignored_names:ignored}:{})};
}

/** Exact decimal text of n/d, rounded half away from zero. */
function decimalText(n:bigint,d:bigint,places:number):string{
  const neg=(n<BigInt(0))!==(d<BigInt(0));
  const a=n<BigInt(0)?-n:n,b=d<BigInt(0)?-d:d;
  const scale=BigInt(10)**BigInt(places);
  const q=(a*scale*BigInt(2)+b)/(b*BigInt(2));
  const whole=(q/scale).toString(),frac=(q%scale).toString().padStart(places,"0").replace(/0+$/u,"");
  const text=frac?whole+"."+frac:whole;
  return neg&&/[1-9]/u.test(text)?"-"+text:text;
}
const shownValue=(v:CalcValue)=>v.unit==="percent"?decimalText(v.n*BigInt(100),v.d,6):decimalText(v.n,v.d,6);

export function calculate(input:{inputs:readonly {name:string;value:string;unit:string}[];
  steps:readonly {id:string;op:string;args:readonly string[]}[]}):Record<string,unknown>{
  const values=new Map<string,CalcValue>();
  for(const item of input.inputs){
    if(!(UNITS as readonly string[]).includes(item.unit))return {ok:false,error:"unknown unit for "+item.name};
    const unit=item.unit as CalcUnit;
    const exact=exactDecimal(String(item.value).trim(),unit,unit==="percent"?100:1);
    if(!exact)return {ok:false,error:"input "+item.name+" is not a plain decimal number: "+item.value};
    if(values.has(item.name))return {ok:false,error:"duplicate input name "+item.name};
    values.set(item.name,exact);
  }
  const outcome=runCalculation(values,input.steps.map(s=>({id:s.id,op:s.op as CalcOp,args:s.args})));
  if(!outcome.ok)return {ok:false,error:outcome.code,...(outcome.stepId?{step:outcome.stepId}:{})};
  return {ok:true,
    result:{id:outcome.result.id,value:shownValue(outcome.result.value),unit:outcome.result.value.unit},
    steps:outcome.steps.map(s=>({id:s.id,op:s.op,args:s.args,value:shownValue(s.value),unit:s.value.unit}))};
}

export async function executeResearchTool(scope:ResearchScope,name:string,rawArguments:string):Promise<Record<string,unknown>>{
  let args:Record<string,unknown>;
  try{args=JSON.parse(rawArguments) as Record<string,unknown>;}catch{return {ok:false,error:"arguments are not valid JSON"};}
  try{
    if(name==="describe_database")
      return await describeDatabase(scope,Array.isArray(args.tables)?args.tables.map(String):null);
    if(name==="run_sql")
      return typeof args.sql==="string"&&args.sql.trim()?await runSql(scope,args.sql):{ok:false,error:"sql is required"};
    if(name==="calculate")
      return calculate({inputs:Array.isArray(args.inputs)?args.inputs as never:[],steps:Array.isArray(args.steps)?args.steps as never:[]});
    return {ok:false,error:"unknown tool "+name};
  }catch(error){
    return {ok:false,error:error instanceof Error?error.message:"tool_failed"};
  }
}
