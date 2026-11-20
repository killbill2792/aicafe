import {PgParser} from "@supabase/pg-parser";

/** PostgreSQL 17's own parser is the grammar authority. All legal query
 * forms remain model-directed; the validator enforces only scope, syntax
 * class, known-safe functions and finite resource complexity. */
const parser=new PgParser({version:17});
const MAX_SQL=12000,MAX_NODES=1800,MAX_RELATIONS=18,MAX_CTES=12;
const prohibited=new Set([
 "InsertStmt","UpdateStmt","DeleteStmt","MergeStmt","CopyStmt","CallStmt",
 "DoStmt","CreateStmt","AlterTableStmt","DropStmt","TruncateStmt",
 "ExecuteStmt","PrepareStmt","DeallocateStmt","VariableSetStmt",
 "VariableShowStmt","TransactionStmt","LockStmt","ExplainStmt","VacuumStmt",
 "GrantStmt","GrantRoleStmt","CreateFunctionStmt","CreateRoleStmt",
 "AlterRoleStmt","CreateTableAsStmt","RefreshMatViewStmt",
 "RangeFunction","RangeTableFunc","RangeTableFuncCol","RangeTableSample",
 "RangeTblRef","XmlExpr","XmlSerialize","XmlTable","TableFunc","CurrentOfExpr","IntoClause"
]);
const functions=new Set([
 "count","sum","avg","min","max","abs","round","floor","ceil","ceiling",
 "coalesce","nullif","greatest","least","date_trunc","date_part","extract",
 "make_date","lower","upper","length","char_length","substring","trim",
 "btrim","ltrim","rtrim","left","right","now","age","to_date",
 "bool_and","bool_or","stddev_pop","stddev_samp","variance","var_pop",
 "var_samp","percentile_cont","percentile_disc","lag","lead","first_value",
 "last_value","row_number","rank","dense_rank","ntile","power","sqrt",
 "mod","sign","trunc","width_bucket"
]);
const operators=new Set([
 "=","<>","!=","<",">","<=",">=","+","-","*","/","%","^","||",
 "~~","!~~","~~*","!~~*","~","~*","!~","!~*","->","->>",
 "#>","#>>","@>","<@","?","?|","?&","&&","BETWEEN"
]);
const casts=new Set([
 "int2","int4","int8","smallint","integer","bigint","numeric","decimal",
 "float4","float8","real","text","varchar","bool","boolean","date",
 "time","timestamp","timestamptz","interval","uuid","json","jsonb"
]);
export type U3SqlAdmission={relations:string[];functions:string[];nodeCount:number;cteCount:number};
const stringNode=(input:unknown)=>{
 if(!input||typeof input!=="object"||!("String" in input))return null;
 const val=(input as {String?:{sval?:unknown}}).String?.sval;
 return typeof val==="string"?val:null;
};
const name=(input:unknown):string|null=>{
 if(!Array.isArray(input))return null;
 const parts=input.map(stringNode);
 return parts.every(p=>p!==null)?parts.join("."):null;
};
const functionName=(n:Record<string,unknown>)=>{
 const full=name(n.funcname);
 if(!full)return null;
 const parts=full.toLowerCase().split(".");
 if(parts.length>2||parts.length===2&&parts[0]!=="pg_catalog")return null;
 return parts[parts.length-1];
};
const castName=(n:Record<string,unknown>)=>{
 const t=n.typeName as {names?:unknown}|undefined;
 const full=name(t?.names);
 if(!full)return null;
 const parts=full.toLowerCase().split(".");
 if(parts.length>2||parts.length===2&&parts[0]!=="pg_catalog")return null;
 return parts[parts.length-1];
};
/** Rejects unbounded or unsafe AST shapes before acquiring a database lock.
 * A successful parse alone is NEVER authorization. The executor must also
 * use a dedicated no-BYPASSRLS scope-bound role and approved research views. */
export async function admitU3Sql(sql:string,allowedRelations:readonly string[],
 parameterCount=0,aggregateOnly=false,offturnColumns:readonly string[]=[]):Promise<U3SqlAdmission>{
 if(typeof sql!=="string"||sql.length>MAX_SQL||!sql.trim()||
  parameterCount<0||parameterCount>48)throw Error("invalid_query");
 const parsed=await parser.parse(sql);
 if(parsed.error||!parsed.tree)throw Error("invalid_query");
 const tree=parsed.tree as unknown as {stmts?:Array<{stmt?:Record<string,unknown>}>};
 if(!Array.isArray(tree.stmts)||tree.stmts.length!==1||
  !tree.stmts[0]?.stmt||!("SelectStmt" in tree.stmts[0].stmt))
  throw Error("invalid_query");
 const catalog=new Set(allowedRelations);
 // Privacy admission depends on source/field semantics, never model aliases.
 // Derived numeric/date-safe columns are admitted as a set from the verified
 // logical catalog. Raw identifiers/free-text are never an off-turn oracle.
 const safeOffturnColumns=new Set(offturnColumns);
 const ctes=new Set<string>();
 let nCtes=0;
 function collect(n:unknown){
  if(!n||typeof n!=="object")return;
  if(Array.isArray(n)){n.forEach(collect);return;}
  for(const [k,v] of Object.entries(n)){
   if(k==="CommonTableExpr"&&v&&typeof v==="object"){
    const id=(v as {ctename?:unknown}).ctename;
    if(typeof id!=="string"||!id||id.length>64||catalog.has(id)||ctes.has(id))
     throw Error("invalid_query");
    ctes.add(id);nCtes++;
   }
   collect(v);
  }
 }
 collect(tree);
 if(nCtes>MAX_CTES)throw Error("invalid_query");
 const reads=new Set<string>(),called=new Set<string>();
 let nodes=0,rangeCount=0;
 const directData=(x:unknown)=>{
  if(!x||typeof x!=="object"||!("ColumnRef" in x))return false;
  const fields=(x as {ColumnRef?:{fields?:unknown}}).ColumnRef?.fields;
  return Array.isArray(fields)&&fields.length>0&&stringNode(fields.at(-1))==="data";
 };
 const hasNamedJsonPath=(x:unknown)=>{
  const literal=x&&typeof x==="object"&&"A_Const" in x?
    (x as {A_Const?:{sval?:{sval?:unknown}}}).A_Const?.sval?.sval:null;
  return typeof literal==="string"&&literal.trim().length>0&&literal.length<=512&&
   !/^\{\s*\}$/.test(literal);
 };
 function walk(n:unknown,allowNamedData=false){
  if(n===null||n===undefined||typeof n==="string"||
    typeof n==="number"||typeof n==="boolean")return;
  if(Array.isArray(n)){n.forEach(value=>walk(value,false));return;}
  if(typeof n!=="object")throw Error("invalid_query");
  nodes++;if(nodes>MAX_NODES)throw Error("invalid_query");
  for(const [kind,raw] of Object.entries(n)){
   if(prohibited.has(kind))throw Error("invalid_query");
   // Reject recursive CTEs regardless of parser nesting or SelectStmt wrapper.
   if(kind==="WithClause"&&raw&&typeof raw==="object"&&
      (raw as {recursive?:unknown}).recursive===true)throw Error("invalid_query");
   if(kind==="A_Expr"&&raw&&typeof raw==="object"){
    const e=raw as {name?:unknown;lexpr?:unknown;rexpr?:unknown};
    if(["#>>","->>"].includes(name(e.name)??"")&&
      directData(e.lexpr)&&hasNamedJsonPath(e.rexpr)){
     walk(e.lexpr,true);walk(e.rexpr,false);continue;
    }
   }
   if(kind==="ColumnRef"){
    const fields=(raw as {fields?:unknown})?.fields;
    if(Array.isArray(fields)&&fields.some(x=>stringNode(x)==="data")&&
      !allowNamedData)throw Error("invalid_query");
   }
   if(kind==="SelectStmt"&&raw&&typeof raw==="object"){
    const s=raw as Record<string,unknown>;
    if(s.intoClause||Array.isArray(s.lockingClause)&&s.lockingClause.length||
      (s.withClause as {WithClause?:{recursive?:boolean}}|undefined)?.WithClause?.recursive)
      throw Error("invalid_query");
   }
   if(kind==="RangeVar"){
    const r=raw as {relname?:unknown;schemaname?:unknown;catalogname?:unknown};
    const rel=typeof r.relname==="string"?r.relname:"";
    if(r.catalogname||r.schemaname&&r.schemaname!=="u3_research"||
      !rel||!catalog.has(rel)&&!ctes.has(rel))throw Error("invalid_query");
    if(catalog.has(rel)){
     reads.add(rel);rangeCount++;
     if(aggregateOnly&&["employees","timecards","scheduled_shifts","cafe_decisions"].includes(rel))
      throw Error("unattended_aggregate_required");
    }
   }
   if(kind==="ColumnRef"&&aggregateOnly){
    const fields=(raw as {fields?:unknown}).fields;
    if(!Array.isArray(fields)||!fields.length)throw Error("unattended_aggregate_required");
    const last=fields[fields.length-1];
    const col=stringNode(last);
    // A SELECT * or ANY sensitive identifier may leak rows through a
    // harmless-looking alias or MIN/MAX, even if the output name looks safe.
    if(!col||!safeOffturnColumns.has(col))
     throw Error("unattended_aggregate_required");
   }
   if(kind==="FuncCall"){
    const fn=functionName(raw as Record<string,unknown>);
    if(!fn||!functions.has(fn))throw Error("invalid_query");
    called.add(fn);
   }
   if(kind==="TypeCast"){
    const type=castName(raw as Record<string,unknown>);
    if(!type||!casts.has(type))throw Error("invalid_query");
   }
   if(kind==="A_Expr"){
    const op=name((raw as {name?:unknown}).name);
    if(op!==null&&!operators.has(op))throw Error("invalid_query");
   }
   if(kind==="ParamRef"){
    const index=(raw as {number?:unknown}).number;
    if(typeof index!=="number"||index<1||index>parameterCount)
      throw Error("invalid_query");
   }
   if(kind==="SQLValueFunction"){
    const op=(raw as {op?:unknown}).op;
    if(!["SVFOP_CURRENT_DATE","SVFOP_CURRENT_TIMESTAMP",
      "SVFOP_LOCALTIMESTAMP"].includes(String(op)))throw Error("invalid_query");
   }
   walk(raw);
  }
 }
 walk(tree);
 if(!reads.size||rangeCount>MAX_RELATIONS)throw Error("invalid_query");
 if(aggregateOnly){
  const target=(tree.stmts[0].stmt?.SelectStmt as {targetList?:unknown})?.targetList;
  if(!Array.isArray(target)||!target.length||
   ![...called].some(fn=>["count","sum","avg","min","max","stddev_pop",
    "stddev_samp","variance","bool_and","bool_or"].includes(fn)))
   throw Error("unattended_aggregate_required");
 }
 return {relations:[...reads].sort(),functions:[...called].sort(),
  nodeCount:nodes,cteCount:nCtes};
}
