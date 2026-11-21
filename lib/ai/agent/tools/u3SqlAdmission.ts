import {PgParser} from "@supabase/pg-parser";
import {isDataField,toastOfficialFieldCatalog} from "@/lib/data/canonical/dictionary";

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
// Scalar path admission is generated from official Toast field definitions,
// not individual owner questions. Parent JSON objects/arrays are NEVER exposed
// as text by model SQL, even through subsequent string expressions.
const splitRoots=[
 "data.checks.0.selections.0.modifiers.0.",
 "data.checks.0.selections.0.appliedDiscounts.0.",
 "data.checks.0.selections.0.",
 "data.checks.0.appliedDiscounts.0.",
 "data.checks.0.appliedServiceCharges.0.",
 "data.checks.0.payments.0.",
 "data.checks.0.",
 "data."
] as const;
const approvedToastScalars=new Set<string>(),complexToastFields=new Set<string>();
for(const source of Object.values(toastOfficialFieldCatalog)){
 for(const [path,types] of source.fields){
  for(const root of splitRoots){
   if(!path.startsWith(root))continue;
   const logical="data."+path.slice(root.length);
   if(!isDataField(logical))continue;
   if(types.every(t=>["string","number","integer","boolean","null"].includes(t)))
    approvedToastScalars.add(logical);
   else complexToastFields.add(logical);
  }
 }
}

export type U3TrustedUnit="cents"|"count"|"percent"|"ratio";
export type U3SqlAdmission={relations:string[];functions:string[];nodeCount:number;cteCount:number;
 outputUnits:Record<string,U3TrustedUnit>};
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
 parameterCount=0,aggregateOnly=false,offturnColumns:readonly string[]=[],
 knownColumnUnits:Readonly<Record<string,U3TrustedUnit|null>>={}):Promise<U3SqlAdmission>{
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
 let nodes=0,rangeCount=0,unitAmbiguousDerivedSource=false;
 // PostgreSQL resolves a single, bare table/CTE alias as a whole composite
 // row whenever it is not a real column. That can be cast to text or passed
 // to aggregate functions, leaking IDs and private fields. Apply this rule
 // to ALL admitted sources and nested FROM aliases, not only Toast JSON.
 const wholeRowNames=new Set<string>();
 const aliasName=(alias:unknown):string|null=>{
  if(!alias||typeof alias!=="object"||Array.isArray(alias))return null;
  const a=alias as {aliasname?:unknown;Alias?:{aliasname?:unknown}};
  const label=a.Alias?.aliasname??a.aliasname;
  return typeof label==="string"&&label.length>0?label:null;
 };
 function collectWholeRowNames(node:unknown):void{
  if(!node||typeof node!=="object")return;
  if(Array.isArray(node)){node.forEach(collectWholeRowNames);return;}
  for(const [key,value] of Object.entries(node)){
   if(["RangeVar","RangeSubselect","JoinExpr"].includes(key)&&
      value&&typeof value==="object"&&!Array.isArray(value)){
    const relation=value as {relname?:unknown;alias?:unknown};
    if(key==="RangeVar"&&typeof relation.relname==="string")
     wholeRowNames.add(relation.relname);
    const alias=aliasName(relation.alias);
    if(alias)wholeRowNames.add(alias);
   }
   collectWholeRowNames(value);
  }
 }
 collectWholeRowNames(tree);
 const directData=(x:unknown)=>{
  if(!x||typeof x!=="object"||!("ColumnRef" in x))return false;
  const fields=(x as {ColumnRef?:{fields?:unknown}}).ColumnRef?.fields;
  return Array.isArray(fields)&&fields.length>0&&stringNode(fields.at(-1))==="data";
 };
 const hasNamedJsonPath=(x:unknown)=>{
  const literal=x&&typeof x==="object"&&"A_Const" in x?
    (x as {A_Const?:{sval?:{sval?:unknown}}}).A_Const?.sval?.sval:null;
  if(typeof literal!=="string"||literal.length>512)return false;
  // PostgreSQL array-style #>> paths or one literal ->> key only.
  // Reuse the existing Toast secret/card-path guard; never permit an
  // arbitrary retained JSON key merely because the SQL is read-only.
  const segments=literal.startsWith("{")&&literal.endsWith("}")?
   literal.slice(1,-1).split(","): [literal];
  const key="data."+segments.join(".");
  return segments.length>0&&segments.length<=16&&
   segments.every(v=>/^(?:[A-Za-z_][A-Za-z0-9_]{0,100}|[0-9]{1,3})$/.test(v))&&
   isDataField(key)&&approvedToastScalars.has(key)&&
   !complexToastFields.has(key);
 };
 function walk(n:unknown,allowNamedData=false){
  if(n===null||n===undefined||typeof n==="string"||
    typeof n==="number"||typeof n==="boolean")return;
  if(Array.isArray(n)){n.forEach(value=>walk(value,false));return;}
  if(typeof n!=="object")throw Error("invalid_query");
  nodes++;if(nodes>MAX_NODES)throw Error("invalid_query");
  for(const [kind,raw] of Object.entries(n)){
   if(prohibited.has(kind))throw Error("invalid_query");
   // SELECT * materializes the entire retained Toast JSON object, including
   // historical fields that never passed named-path secret admission.
   // Explicit columns are required; COUNT(*) is encoded as FuncCall.agg_star.
   if(kind==="A_Star")throw Error("invalid_query");
   // PostgreSQL table/CTE column-alias lists rewrite the *names* of source
   // columns. Our privacy and dimensional admission use approved source names,
   // so aliases for table columns are not supported until lineage resolution
   // is implemented. Ordinary table aliases and output aliases remain legal.
   if((kind==="colnames"||kind==="aliascolnames")&&
      Array.isArray(raw)&&raw.length>0)throw Error("invalid_query");
   // Derived/aliased CTE and set-operation columns may shadow source names.
   // Research may still use them, but the exact calculator cannot treat a
   // projected alias as proof of its original monetary dimension.
   if(kind==="RangeSubselect")unitAmbiguousDerivedSource=true;
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
    // ColumnRef of a FROM relation/alias denotes a whole composite row.
    // Never let an alias shadow a permitted safe-column name or the Toast
    // data guard. Safe failure is preferable to unscoped whole-row text.
    if(Array.isArray(fields)&&fields.length===1&&
       wholeRowNames.has(stringNode(fields[0])??""))throw Error("invalid_query");
   }
   if(kind==="SelectStmt"&&raw&&typeof raw==="object"){
    const s=raw as Record<string,unknown>;
    if(s.larg||s.rarg)unitAmbiguousDerivedSource=true;
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
     if(aggregateOnly&&["employees","timecards","scheduled_shifts","cafe_decisions",
      "employee_pay_period_facts","staff_availability_rules",
      "staff_availability_exceptions"].includes(rel))
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

 // A model-authored SELECT alias is NOT source authority. Infer a unit only
 // from the approved source column and operation, not from the output name.
 // Unsafe/ambiguous expressions remain calculable as SQL research but do not
 // become a trusted input to the exact canonical calculator.
 type N=Record<string,unknown>;
 const recognized=(v:unknown):U3TrustedUnit|null=>
  v==="cents"||v==="count"||v==="percent"||v==="ratio"?v:null;
 const infer=(node:unknown):U3TrustedUnit|null=>{
  if(!node||typeof node!=="object"||Array.isArray(node))return null;
  const obj=node as N;
  if(obj.ColumnRef&&typeof obj.ColumnRef==="object"){
   const fields=(obj.ColumnRef as {fields?:unknown}).fields;
   if(!Array.isArray(fields)||!fields.length)return null;
   const col=stringNode(fields[fields.length-1]);
   return col?recognized(knownColumnUnits[col]):null;
  }
  if(obj.FuncCall&&typeof obj.FuncCall==="object"){
   const fn=obj.FuncCall as N,operation=functionName(fn);
   if(operation==="count")return "count";
   if(!["sum","min","max"].includes(operation??""))return null;
   const args=fn.args;
   return Array.isArray(args)&&args.length===1?infer(args[0]):null;
  }
  if(obj.A_Expr&&typeof obj.A_Expr==="object"){
   const expr=obj.A_Expr as N,op=name(expr.name);
   const left=infer(expr.lexpr),right=infer(expr.rexpr);
   return (op==="+"||op==="-")&&left!==null&&left===right?left:null;
  }
  if(obj.TypeCast&&typeof obj.TypeCast==="object"){
   const cast=obj.TypeCast as N,type=castName(cast);
   return ["int2","int4","int8","smallint","integer","bigint",
    "numeric","decimal"].includes(type??"")?infer(cast.arg):null;
  }
  return null;
 };
 const outputUnits:Record<string,U3TrustedUnit>={};
 const targets=(tree.stmts[0].stmt.SelectStmt as {targetList?:unknown}).targetList;
 const seenLabels=new Set<string>();
 // Check ALL result labels before trusting ANY unit. PostgreSQL allows
 // duplicate column labels and node-postgres overwrites object properties
 // with later values, including constants deliberately mislabeled as money.
 if(Array.isArray(targets))for(const t of targets){
  if(!t||typeof t!=="object"||!("ResTarget" in t))continue;
  const target=(t as {ResTarget?:{name?:unknown;val?:unknown}}).ResTarget;
  const value=target?.val;
  const fallback=value&&typeof value==="object"&&"ColumnRef" in value?
   name((value as {ColumnRef?:{fields?:unknown}}).ColumnRef?.fields)?.split(".").at(-1):
   value&&typeof value==="object"&&"FuncCall" in value?
    functionName((value as {FuncCall:N}).FuncCall):null;
  const alias=typeof target?.name==="string"?target.name:fallback;
  if(!alias||!/^[a-zA-Z_][a-zA-Z0-9_]{0,99}$/.test(alias))continue;
  if(seenLabels.has(alias))throw Error("invalid_query");
  seenLabels.add(alias);
  if(nCtes!==0||unitAmbiguousDerivedSource)continue;
  const unit=infer(value);
  if(unit)outputUnits[alias]=unit;
 }
 return {relations:[...reads].sort(),functions:[...called].sort(),
  nodeCount:nodes,cteCount:nCtes,outputUnits};
}
