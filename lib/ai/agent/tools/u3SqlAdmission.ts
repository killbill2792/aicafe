import {PgParser} from "@supabase/pg-parser";
import {isDataField,toastOfficialFieldCatalog} from "@/lib/data/canonical/dictionary";

/** PostgreSQL 17's own parser is the grammar authority. All legal query
 * forms remain model-directed; the validator enforces only scope, syntax
 * class, known-safe functions and finite resource complexity. */
const parser=new PgParser({version:17});
// Bound pre-parse memory and actual AST traversal, not the length of an
// ordinary analytical statement. The transport/provider also bounds requests.
// The byte guard is a defensive parser resource limit, not a business rule.
const MAX_PARSER_BYTES=256*1024,MAX_NODES=1800;
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
 "mod","sign","trunc","width_bucket",
 // Pure built-in transformations of already admitted source values. In
 // particular AT TIME ZONE is parsed as the timezone() function; rejecting
 // it makes ordinary business-local timestamp research impossible.
 "timezone","date_bin","to_char","split_part","replace","concat","concat_ws",
 "strpos","position","initcap","regexp_replace","regexp_count","regexp_like",
 "regexp_substr","regexp_instr","cume_dist","percent_rank","nth_value"
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

export const ownerOnlyResearchRelations:ReadonlySet<string>=new Set(["employees","timecards","scheduled_shifts","cafe_decisions","employee_pay_period_facts","timecard_breaks","current_owner_facts","staff_availability_rules","staff_availability_exceptions","staff_schedules","pos_scheduled_shifts","staff_scheduling_preferences","staff_qualifications","staff_custom_rules","recorded_timecards","supplier_quotes","goal_metrics","goal_observations","goal_checkins"]);

export type U3TrustedUnit="cents"|"microcents"|"count"|"percent"|"ratio";
export type U3RelationUnits=Readonly<Record<string,Readonly<Record<string,U3TrustedUnit|null>>>>;
export type U3ColumnOrigin={relation:string;column:string;binding:number};
export type U3SqlAdmission={relations:string[];functions:string[];nodeCount:number;cteCount:number;
 outputUnits:Record<string,U3TrustedUnit>;outputOrigins:Record<string,U3ColumnOrigin>;hasTopLevelOrder:boolean};
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
export type U3AdmissionReason="statement_not_read_only"|"syntax"|"parser_resource_bound"|
 "unapproved_relation"|"explicit_columns_required"|"unapproved_function"|"unapproved_operator"|
 "unapproved_cast"|"unbound_parameter"|"unsupported_recursive_query"|"no_admitted_source";
export class U3AdmissionError extends Error{
 constructor(readonly reason:U3AdmissionReason){super("invalid_query");this.name="U3AdmissionError";}
}
export async function admitU3Sql(sql:string,allowedRelations:readonly string[],
 parameterCount=0,aggregateOnly=false,offturnColumns:readonly string[]=[],
 knownColumnUnits:Readonly<Record<string,U3TrustedUnit|null>>={},
 relationUnits?:U3RelationUnits,
 offturnByRelation?:Readonly<Record<string,readonly string[]>>):Promise<U3SqlAdmission>{
 if(typeof sql!=="string"||!sql.trim()||
  parameterCount<0||parameterCount>65535)throw Error("invalid_query");
 if(Buffer.byteLength(sql,"utf8")>MAX_PARSER_BYTES)
  throw new U3AdmissionError("parser_resource_bound");
 const parsed=await parser.parse(sql);
 if(parsed.error||!parsed.tree)throw new U3AdmissionError("syntax");
 const tree=parsed.tree as unknown as {stmts?:Array<{stmt?:Record<string,unknown>}>};
 if(!Array.isArray(tree.stmts)||tree.stmts.length!==1||
  !tree.stmts[0]?.stmt||!("SelectStmt" in tree.stmts[0].stmt))
  throw new U3AdmissionError("statement_not_read_only");
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
 const reads=new Set<string>(),called=new Set<string>();
 let nodes=0,starSeen=false;
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
  nodes++;if(nodes>MAX_NODES)throw new U3AdmissionError("parser_resource_bound");
  for(const [kind,raw] of Object.entries(n)){
   if(prohibited.has(kind))throw new U3AdmissionError("statement_not_read_only");
   // Ordinary scoped relational views expose only reviewed business fields.
   // Wildcards are legitimate owner SQL there. Raw retained JSON or an
   // unattended row enumeration must still use explicit safe projections.
   // COUNT(*) is encoded as FuncCall.agg_star and is not a row wildcard.
   if(kind==="A_Star"){
    if(aggregateOnly)throw Error("unattended_aggregate_required");
    starSeen=true;
   }
   // PostgreSQL table/CTE column-alias lists rewrite the *names* of source
   // columns. Our privacy and dimensional admission use approved source names,
   // so aliases for table columns are not supported until lineage resolution
   // is implemented. Ordinary table aliases and output aliases remain legal.
   if((kind==="colnames"||kind==="aliascolnames")&&
      Array.isArray(raw)&&raw.length>0)throw Error("invalid_query");
   // Reject recursive CTEs regardless of parser nesting or SelectStmt wrapper.
   if((kind==="WithClause"||kind==="withClause")&&raw&&typeof raw==="object"&&
      ((raw as {recursive?:unknown}).recursive===true||
       (raw as {WithClause?:{recursive?:unknown}}).WithClause?.recursive===true))throw new U3AdmissionError("unsupported_recursive_query");
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
    if(s.intoClause||Array.isArray(s.lockingClause)&&s.lockingClause.length||
      (s.withClause as {WithClause?:{recursive?:boolean}}|undefined)?.WithClause?.recursive)
      throw Error("invalid_query");
   }
   if(kind==="RangeVar"){
    const r=raw as {relname?:unknown;schemaname?:unknown;catalogname?:unknown};
    const rel=typeof r.relname==="string"?r.relname:"";
    if(r.catalogname||r.schemaname&&r.schemaname!=="u3_research"||
      !rel||!catalog.has(rel)&&!ctes.has(rel))throw new U3AdmissionError("unapproved_relation");
    if(catalog.has(rel)){
     reads.add(rel);
     if(aggregateOnly&&ownerOnlyResearchRelations.has(rel))
      throw Error("unattended_aggregate_required");
    }
   }
   if(kind==="ColumnRef"&&aggregateOnly&&!offturnByRelation){
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
    if(!fn||!functions.has(fn))throw new U3AdmissionError("unapproved_function");
    called.add(fn);
   }
   if(kind==="TypeCast"){
    const type=castName(raw as Record<string,unknown>);
    if(!type||!casts.has(type))throw new U3AdmissionError("unapproved_cast");
   }
   if(kind==="A_Expr"){
    const op=name((raw as {name?:unknown}).name);
    if(op!==null&&!operators.has(op))throw new U3AdmissionError("unapproved_operator");
   }
   if(kind==="ParamRef"){
    const index=(raw as {number?:unknown}).number;
    if(typeof index!=="number"||index<1||index>parameterCount)
      throw new U3AdmissionError("unbound_parameter");
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
 if(!reads.size)throw new U3AdmissionError("no_admitted_source");
 if(starSeen&&[...reads].some(rel=>rel==="toast_records"||
   Object.hasOwn(relationUnits?.[rel]??{},"data")))
  throw new U3AdmissionError("explicit_columns_required");

 // Resolve dimensions and direct-column identity through actual SELECT
 // scope, not output labels. Computed expressions retain unit when their
 // operands justify it, but never inherit a direct source-row identity.
 type N=Record<string,unknown>;
 type Unit=U3TrustedUnit|null;
 type Field={unit:Unit;origin?:U3ColumnOrigin};
 type Columns=Map<string,Field>;
 type Binding={name:string;columns:Columns};
 const obj=(x:unknown):N|null=>x&&typeof x==="object"&&!Array.isArray(x)?x as N:null;
 const unwrap=(x:unknown,key:string):N|null=>{const v=obj(x);return v?obj(v[key])??v:null;};
 // An aggregate in a nested predicate or window does not reduce the
 // top-level source rows. Prove the actual returned grain; projections over
 // already-aggregated CTEs/subqueries remain composable without another sum.
 const reducingFunctions=new Set(["count","sum","avg","min","max","stddev_pop",
  "stddev_samp","variance","var_pop","var_samp","bool_and","bool_or",
  "percentile_cont","percentile_disc"]);
 function hasReducingAggregate(node:unknown):boolean{
  if(Array.isArray(node))return node.some(hasReducingAggregate);
  const entry=obj(node);if(!entry)return false;
  if(entry.SelectStmt||entry.SubLink)return false;
  const fn=obj(entry.FuncCall);
  if(fn&&!fn.over&&reducingFunctions.has(functionName(fn)??""))return true;
  return Object.values(entry).some(hasReducingAggregate);
 }
 function reducedGrain(node:unknown,inherited:ReadonlyMap<string,boolean>):boolean{
  const select=unwrap(node,"SelectStmt");if(!select)return false;
  const local=new Map(inherited);
  const clause=unwrap(select.withClause,"WithClause");
  for(const raw of Array.isArray(clause?.ctes)?clause.ctes:[]){
   const c=unwrap(raw,"CommonTableExpr");
   if(c&&typeof c.ctename==="string")local.set(c.ctename,reducedGrain(c.ctequery,local));
  }
  if(select.larg&&select.rarg)
   return reducedGrain(select.larg,local)&&reducedGrain(select.rarg,local);
  if(hasReducingAggregate(select.targetList)||hasReducingAggregate(select.havingClause))return true;
  const reducedFrom=(raw:unknown):boolean=>{
   const entry=obj(raw);if(!entry)return false;
   const rel=obj(entry.RangeVar);
   if(rel&&typeof rel.relname==="string")return !rel.schemaname&&local.get(rel.relname)===true;
   const derived=obj(entry.RangeSubselect);
   if(derived)return reducedGrain(derived.subquery,local);
   const join=obj(entry.JoinExpr);
   return !!join&&reducedFrom(join.larg)&&reducedFrom(join.rarg);
  };
  const from=Array.isArray(select.fromClause)?select.fromClause:[];
  return from.length>0&&from.every(reducedFrom);
 }
 if(aggregateOnly&&!reducedGrain(tree.stmts[0].stmt,new Map()))
  throw Error("unattended_aggregate_required");
 const recognized=(v:unknown):Unit=>v==="cents"||v==="microcents"||v==="count"||v==="percent"||v==="ratio"?v:null;
 let bindingSequence=0;
 const baseColumns=(rel:string):Columns=>{
  const binding=++bindingSequence;
  return new Map(Object.entries(relationUnits?relationUnits[rel]??{}:knownColumnUnits)
   .map(([column,v])=>[column,{unit:recognized(v),origin:{relation:rel,column,binding}}]));
 };
 // A CTE reused under two aliases represents two independent row bindings.
 // Never combine a clock from one binding with a person from another.
 const rebind=(columns:Columns):Columns=>{
  const instances=new Map<number,number>();
  return new Map([...columns].map(([label,field])=>{
   if(!field.origin)return [label,field];
   const {binding}=field.origin;
   if(!instances.has(binding))instances.set(binding,++bindingSequence);
   return [label,{...field,origin:{...field.origin,binding:instances.get(binding)!}}];
  }));
 };
 const targetName=(target:N)=>{
  if(typeof target.name==="string"&&target.name.length>0)return target.name;
  const v=obj(target.val);
  const ref=obj(v?.ColumnRef);
  return ref&&Array.isArray(ref.fields)?stringNode(ref.fields.at(-1)):
   obj(v?.FuncCall)?functionName(obj(v?.FuncCall)!):null;
 };
 const direct=(node:unknown,bindings:Binding[]):Field|null=>{
  const ref=obj(obj(node)?.ColumnRef);
  if(!ref||!Array.isArray(ref.fields)||ref.fields.length<1||ref.fields.length>3)return null;
  const parts=ref.fields.map(stringNode);
  if(parts.some(part=>part===null))return null;
  const col=parts.at(-1)!;
  const qualifier=parts.length>1?parts.at(-2):null;
  const candidates=bindings.filter(b=>(qualifier===null||b.name===qualifier)&&b.columns.has(col));
  return candidates.length===1?candidates[0].columns.get(col)??null:null;
 };
 // The zero/null branch is dimension-neutral. Nonzero untyped literals
 // never establish a currency/count by a conveniently chosen output label.
 const neutral=(node:unknown):boolean=>{
  const v=obj(obj(node)?.A_Const);
  if(!v)return false;
  const i=obj(v.ival),f=obj(v.fval);
  return v.isnull===true||i!==null&&(i.ival===0||i.ival===undefined)||
   typeof f?.fval==="string"&&/^[+-]?0+(?:\.0+)?$/u.test(f.fval);
 };
 const compatible=(nodes:unknown[],bindings:Binding[]):Unit=>{
  const units=nodes.map(n=>infer(n,bindings));
  const typed=units.filter((u):u is U3TrustedUnit=>u!==null);
  return typed.length&&typed.every(u=>u===typed[0])&&
   units.every((u,i)=>u!==null||neutral(nodes[i]))?typed[0]:null;
 };
 const infer=(node:unknown,bindings:Binding[]):Unit=>{
  const v=obj(node);if(!v)return null;
  if(v.ColumnRef)return direct(node,bindings)?.unit??null;
  const fn=obj(v.FuncCall);
  if(fn){
   const operation=functionName(fn),args=Array.isArray(fn.args)?fn.args:[];
   if(operation==="count")return "count";
   if(["sum","min","max","avg","first_value","last_value","abs","floor","ceil","ceiling"].includes(operation??"")&&args.length===1)
    return infer(args[0],bindings);
   if(["round","trunc"].includes(operation??"")&&args.length>=1&&args.length<=2)
    return infer(args[0],bindings);
   if(["lag","lead","nth_value"].includes(operation??"")&&args.length>=1&&args.length<=3){
    const first=infer(args[0],bindings);
    return args.length<3||infer(args[2],bindings)===first?first:null;
   }
   return null;
  }
  const coalesce=obj(v.CoalesceExpr),minmax=obj(v.MinMaxExpr);
  if(coalesce||minmax)return compatible(Array.isArray((coalesce??minmax)?.args)?(coalesce??minmax)!.args as unknown[]:[],bindings);
  const conditional=obj(v.CaseExpr);
  if(conditional){
   const branches=(Array.isArray(conditional.args)?conditional.args:[])
    .map(x=>unwrap(x,"CaseWhen")?.result);
   if(conditional.defresult!==undefined)branches.push(conditional.defresult);
   return compatible(branches,bindings);
  }
  const expr=obj(v.A_Expr);
  if(expr){
   const op=name(expr.name),left=infer(expr.lexpr,bindings),right=infer(expr.rexpr,bindings);
   if(expr.kind==="AEXPR_NULLIF")return left;
   if((op==="+"||op==="-")&&left!==null&&left===right)return left;
   if((op==="+"||op==="-")&&left!==null&&neutral(expr.rexpr))return left;
   if(op==="+"&&right!==null&&neutral(expr.lexpr))return right;
   if(op==="/"&&left!==null&&left===right)return "ratio";
   return null;
  }
  const cast=obj(v.TypeCast);
  if(cast)return ["int2","int4","int8","smallint","integer","bigint","numeric","decimal"].includes(castName(cast)??"")?
   infer(cast.arg,bindings):null;
  return null;
 };
 function projection(node:unknown,inherited:ReadonlyMap<string,Columns>):Columns{
  const select=unwrap(node,"SelectStmt");if(!select)return new Map();
  const local=new Map(inherited);
  const withClause=unwrap(select.withClause,"WithClause");
  for(const raw of Array.isArray(withClause?.ctes)?withClause.ctes:[]){
   const c=unwrap(raw,"CommonTableExpr");
   if(c&&typeof c.ctename==="string")local.set(c.ctename,projection(c.ctequery,local));
  }
  // Set operations are readable, but positional lineage through multiple
  // SELECTs is not inferred unless independently proven.
  if(select.larg&&select.rarg)return new Map();
  const bindings:Binding[]=[];
  const from=(raw:unknown):void=>{
   const entry=obj(raw);if(!entry)return;
   const rel=obj(entry.RangeVar);
   if(rel&&typeof rel.relname==="string"){
    const derived=local.get(rel.relname);
    const columns=derived?rebind(derived):catalog.has(rel.relname)?baseColumns(rel.relname):new Map();
    bindings.push({name:aliasName(rel.alias)??rel.relname,columns});return;
   }
   const derived=obj(entry.RangeSubselect);
   if(derived){
    const label=aliasName(derived.alias);
    if(label)bindings.push({name:label,columns:projection(derived.subquery,local)});
    return;
   }
   const join=obj(entry.JoinExpr);
   if(join){
    if(aliasName(join.alias))return;
    from(join.larg);from(join.rarg);
   }
  };
  for(const item of Array.isArray(select.fromClause)?select.fromClause:[])from(item);
  const result:Columns=new Map();
  const add=(label:string,field:Field)=>{
   if(result.has(label))throw Error("invalid_query");
   result.set(label,field);
  };
  for(const raw of Array.isArray(select.targetList)?select.targetList:[]){
   const target=unwrap(raw,"ResTarget");if(!target)continue;
   const ref=obj(obj(target.val)?.ColumnRef);
   if(Array.isArray(ref?.fields)&&Object.hasOwn(obj(ref.fields.at(-1))??{},"A_Star")){
    const qualifier=ref.fields.length>1?stringNode(ref.fields.at(-2)):null;
    const selected=bindings.filter(b=>qualifier===null||b.name===qualifier);
    // PostgreSQL handles JOIN USING/NATURAL and unknown derived columns.
    // Do not certify an ambiguous wildcard's dimensions; the actual
    // executor independently rejects duplicate returned field labels.
    if(selected.length!==1)return new Map();
    for(const [label,field] of selected[0].columns){
     if(result.has(label))throw Error("duplicate_result_columns");
     add(label,field);
    }
    continue;
   }
   const label=targetName(target);
   if(!label||!/^[a-zA-Z_][a-zA-Z0-9_]{0,99}$/.test(label))continue;
   add(label,direct(target.val,bindings)??{unit:infer(target.val,bindings)});
  }
  return result;
 }
 // Production supplies the actual relation-specific privacy catalog. Validate
 // input column references in their lexical SELECT scope; an identically
 // named field in a different relation is not authorization. A derived alias
 // of validated evidence is safe independently of its spelling.
 if(aggregateOnly&&offturnByRelation&&relationUnits){
  type PrivacyColumns=Map<string,boolean>;
  type PrivacyBinding={name:string;columns:PrivacyColumns};
  const deny=():never=>{throw Error("unattended_aggregate_required");};
  const localFields=(rel:string):PrivacyColumns=>new Map(Object.keys(relationUnits[rel]??{})
   .map(column=>[column,(offturnByRelation[rel]??[]).includes(column)]));
  function checkedSelect(node:unknown,inherited:ReadonlyMap<string,PrivacyColumns>,outer:PrivacyBinding[][]):PrivacyColumns{
   const select=unwrap(node,"SelectStmt");if(!select)return deny();
   const local=new Map(inherited);
   const withClause=unwrap(select.withClause,"WithClause");
   for(const raw of Array.isArray(withClause?.ctes)?withClause.ctes:[]){
    const ct=unwrap(raw,"CommonTableExpr");
    if(ct&&typeof ct.ctename==="string")local.set(ct.ctename,checkedSelect(ct.ctequery,local,outer));
   }
   const bindings:PrivacyBinding[]=[];
   function checkRef(raw:unknown,allowOutput?:PrivacyColumns){
    const ref=obj(raw);
    const parts=Array.isArray(ref?.fields)?ref.fields.map(stringNode):[];
    if(!parts.length||parts.some(p=>p===null))return deny();
    const column=parts.at(-1)!,qualifier=parts.length>1?parts.at(-2):null;
    if(qualifier===null&&allowOutput?.get(column)===true)return;
    for(const scope of [bindings,...outer]){
     const qualified=qualifier===null?scope:scope.filter(b=>b.name===qualifier);
     const candidates=qualified.filter(b=>b.columns.has(column));
     if(candidates.length){
      if(candidates.length!==1||candidates[0].columns.get(column)!==true)return deny();
      return;
     }
     if(qualifier!==null&&qualified.length)return deny();
    }
    return deny();
   }
   function scan(raw:unknown):void{
    if(Array.isArray(raw)){raw.forEach(scan);return;}
    const entry=obj(raw);if(!entry)return;
    if(entry.SelectStmt){checkedSelect(entry,local,[bindings,...outer]);return;}
    if(entry.ColumnRef){checkRef(entry.ColumnRef);return;}
    Object.values(entry).forEach(scan);
   }
   function from(raw:unknown):void{
    const entry=obj(raw);if(!entry)return;
    const rel=obj(entry.RangeVar);
    if(rel&&typeof rel.relname==="string"){
     const columns=!rel.schemaname?local.get(rel.relname):undefined;
     bindings.push({name:aliasName(rel.alias)??rel.relname,columns:columns??localFields(rel.relname)});return;
    }
    const derived=obj(entry.RangeSubselect);
    if(derived){
     const label=aliasName(derived.alias);
     const columns=checkedSelect(derived.subquery,local,derived.lateral?[bindings,...outer]:outer);
     if(label)bindings.push({name:label,columns});return;
    }
    const join=obj(entry.JoinExpr);
    if(join){
     const first=bindings.length;from(join.larg);
     const middle=bindings.length;from(join.rarg);
     const left=bindings.slice(first,middle),right=bindings.slice(middle);
     const leftFields=new Map(left.flatMap(b=>[...b.columns]));
     const rightFields=new Map(right.flatMap(b=>[...b.columns]));
     // USING/NATURAL can reference source fields without ColumnRef AST nodes.
     const keys=join.isNatural?[...leftFields.keys()].filter(k=>rightFields.has(k)):
      Array.isArray(join.usingClause)?join.usingClause.map(stringNode):[];
     for(const key of keys)if(!key||leftFields.get(key)!==true||rightFields.get(key)!==true)return deny();
     scan(join.quals);
     const label=aliasName(join.alias);
     if(label){
      const combined=new Map(leftFields);
      for(const [key,safe] of rightFields)combined.set(key,combined.has(key)?combined.get(key)===true&&safe:safe);
      bindings.splice(first,bindings.length-first,{name:label,columns:combined});
     }
    }
   }
   for(const raw of Array.isArray(select.fromClause)?select.fromClause:[])from(raw);
   let output:PrivacyColumns=new Map();
   if(select.larg&&select.rarg){
    output=checkedSelect(select.larg,local,outer);
    checkedSelect(select.rarg,local,outer);
   }else{
    for(const raw of Array.isArray(select.targetList)?select.targetList:[]){
     const target=unwrap(raw,"ResTarget");if(!target)continue;
     scan(target.val);
     const label=targetName(target);if(label)output.set(label,true);
    }
   }
   for(const [key,value] of Object.entries(select)){
    if(["withClause","fromClause","targetList","larg","rarg","sortClause","groupClause"].includes(key))continue;
    scan(value);
   }
   // PostgreSQL allows top-level ORDER BY output labels and GROUP BY labels
   // not shadowed by input columns. Do not confuse either with a base field
   // in a nested expression.
   for(const raw of Array.isArray(select.sortClause)?select.sortClause:[]){
    const sort=unwrap(raw,"SortBy"),value=obj(sort?.node);
    if(value?.ColumnRef)checkRef(value.ColumnRef,output);else scan(sort?.node);
   }
   for(const raw of Array.isArray(select.groupClause)?select.groupClause:[]){
    const ref=obj(obj(raw)?.ColumnRef);
    const label=Array.isArray(ref?.fields)&&ref.fields.length===1?stringNode(ref.fields[0]):null;
    if(label&&output.get(label)===true&&!bindings.some(b=>b.columns.has(label)))continue;
    scan(raw);
   }
   return output;
  }
  checkedSelect(tree.stmts[0].stmt,new Map(),[]);
 }
 const projected=projection(tree.stmts[0].stmt,new Map());
 const outputUnits=Object.fromEntries([...projected].flatMap(([label,field])=>
  field.unit===null?[]:[[label,field.unit] as const]));
 const outputOrigins=Object.fromEntries([...projected].flatMap(([label,field])=>
  field.origin?[[label,field.origin] as const]:[]));
 return {relations:[...reads].sort(),functions:[...called].sort(),
  nodeCount:nodes,cteCount:nCtes,outputUnits,outputOrigins,
  hasTopLevelOrder:Array.isArray((tree.stmts[0].stmt.SelectStmt as {sortClause?:unknown}).sortClause)&&
   ((tree.stmts[0].stmt.SelectStmt as {sortClause?:unknown[]}).sortClause??[]).length>0};
}
