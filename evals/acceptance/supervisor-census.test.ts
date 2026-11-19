import {describe,it,expect,vi} from "vitest";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {Client} from "pg";
import {TEST_CAFES} from "../../scripts/seed/cafes.mjs";
import {resolve} from "node:path";
import ts from "typescript";
import {z} from "zod";
import {schemas,agentToolDefinitions,investigationToolDefinition,gmailToolDefinitions,executeAgentTool,type AgentToolContext} from "@/lib/ai/agent/tools";
import {memoryToolDefinition,memoryTools} from "@/lib/ai/agent/tools/memory";
import {dataQueryTools,officialToastFields} from "@/lib/ai/agent/tools/dataQuery";
import {routineToolDefinition} from "@/lib/ai/agent/tools/routines";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {routineStatusSchema,routineScheduleSchema} from "@/lib/ai/supervisor/routines/contracts";
import {metricCatalog,metricKeySchema,computeMetric,type MetricKey,type MetricDailyInput} from "@/lib/calc/metrics/catalog";
import {canonicalDictionary,canonicalViewNames,toastOfficialFieldCatalog,isDataField} from "@/lib/data/canonical/dictionary";
import {connectorOperations} from "@/lib/connectors/registry.server";
import {row,schemaCases,manifestIndex,makeInventory,buildCensusReport,writeCensus,verifyBootstrapSnapshot} from "../../scripts/acceptance/supervisor-coverage.mjs";
import truth from "./fixtures/task17b-business-truth.json";
import coverageMap from "./fixtures/task17b-coverage-map.json";
const deterministicMetrics:string[]=[];
const fullSchemas={...schemas,...memoryTools};
const fullDefinitions=[...agentToolDefinitions,...gmailToolDefinitions,investigationToolDefinition,routineToolDefinition,memoryToolDefinition];

const git=(...args:string[])=>execFileSync("git",args,{encoding:"utf8"}).trim();
const root=git("rev-parse","--show-toplevel");
const paths=git("ls-files","-z").split("\0").filter(Boolean);
const schemaJson=(schema:z.ZodType)=>z.toJSONSchema(schema,{target:"draft-07",unrepresentable:"any"});
const source=(path:string)=>readFileSync(resolve(root,path),"utf8");
const fingerprintedExports=(path:string)=>{
 const ast=ts.createSourceFile(path,source(path),ts.ScriptTarget.Latest,true);
 return ast.statements.flatMap(s=>{
  if(!ts.canHaveModifiers(s)||!ts.getModifiers(s)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))return [];
  if(ts.isFunctionDeclaration(s)&&s.name)return [row("core-export",path+"#"+s.name.text,s.getText(ast))];
  if(ts.isVariableStatement(s))return s.declarationList.declarations.map(d=>row("core-export",path+"#"+d.name.getText(ast),s.getText(ast)));
  return [];
 });
};

// Existing test text is only a discovery lead: require a real test declaration,
// exact registered identifier inside its callback and a tracked source path.
// Do not treat a string match, mocked port or test manifest as executed proof.
function findTestReferences(names:Set<string>){
 const result=new Map<string,{path:string,title:string}[]>();
 for(const path of paths.filter(p=>/^lib\/ai\/|^evals\/supervisor\/|^lib\/data\/canonical\//.test(p)&&/\.test\.tsx?$/.test(p)&&!p.endsWith(".live.test.ts"))){
  const ast=ts.createSourceFile(path,source(path),ts.ScriptTarget.Latest,true);
  const visit=(node:ts.Node)=>{
   if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&["it","test"].includes(node.expression.text)){
    const title=node.arguments[0],cb=node.arguments[1];
    if(title&&ts.isStringLiteralLike(title)&&cb&&(ts.isArrowFunction(cb)||ts.isFunctionExpression(cb))){
     const used=new Set<string>();
     const scan=(n:ts.Node)=>{
      if(ts.isStringLiteralLike(n)&&names.has(n.text))used.add(n.text);
      if(ts.isPropertyAccessExpression(n)&&names.has(n.name.text))used.add(n.name.text);
      ts.forEachChild(n,scan);
     };
     scan(cb.body);
     for(const name of used){const list=result.get(name)??[];list.push({path,title:title.text});result.set(name,list);}
    }
   }
   ts.forEachChild(node,visit);
  };
  visit(ast);
 }
 return result;
}
describe("Task17B first-party changing capability inventory (no provider)",()=>{
 it("independent arithmetic truth covers every currently registered metric, including no-data negatives",()=>{
  const day=truth.day as MetricDailyInput;
  expect(Object.keys(truth.expected).sort()).toEqual(Object.keys(metricCatalog).sort());
  for(const [key,entry] of Object.entries(truth.expected)){
   const result=computeMetric(key as MetricKey,entry.params,day);
   expect(result.value,key).toBe(entry.value);
   expect(result.coverage,key).toBe(1);
   expect(metricCatalog[key as MetricKey].unit,key).toBe(entry.unit);
   const unknown=computeMetric(key as MetricKey,entry.params,{date:day.date});
   expect(unknown.value,key+" missing").toBeNull();
   expect(unknown.coverage,key+" missing").toBeLessThan(1);
   deterministicMetrics.push(key);
  }
 });
 it("censuses actual registered tools, gated operations, canonical fields, effects and surfaces",()=>{
  const visible=new Map(fullDefinitions.map(t=>[t.name,t]));
  expect(visible.size).toBe(fullDefinitions.length);
  expect([...visible.keys()].sort()).toEqual(Object.keys(fullSchemas).sort());
  const rows=Object.entries(fullSchemas).flatMap(([name,entry])=>{
   const schema="schema" in entry?entry.schema:entry;
   const json=schemaJson(schema);
   return [row("tool",name,{input:json,advertised:visible.has(name)}),...schemaCases("tool-input",name,json)];
  });
  for(const name of visible.keys())expect(Object.hasOwn(fullSchemas,name)).toBe(true);
  expect(Object.keys(metricCatalog).sort()).toEqual([...metricKeySchema.options].sort());
  expect(Object.keys(canonicalDictionary).sort()).toEqual([...canonicalViewNames].sort());
  for(const [key,metric] of Object.entries(metricCatalog)){
   const json=schemaJson(metric.paramsSchema);
   rows.push(row("metric",key,{unit:metric.unit,input:json}),...schemaCases("metric-input",key,json));
  }
  for(const [view,definition] of Object.entries(canonicalDictionary)){
   rows.push(row("canonical-view",view,definition.meaning));
   for(const [field,contract] of Object.entries(definition.columns))rows.push(row("canonical-field",view+"."+field,contract));
  }
  for(const [family,catalog] of Object.entries(toastOfficialFieldCatalog)){
   for(const [field,types] of catalog.fields)rows.push(row("toast-schema-field",family+":"+field,{types,version:catalog.version,queryPathAllowed:isDataField(field)}));
  }
  for(const id of supervisorLoopRegistry.list()){
   const capability=supervisorLoopRegistry.get(id);
   rows.push(row("effect",id,{version:capability.version,input:capability.proposalInputJsonSchema,mandate:capability.mandatePolicy??null}),
    ...schemaCases("effect-input",id,capability.proposalInputJsonSchema));
  }
  for(const operation of connectorOperations)rows.push(row("connector-operation","gmail:"+operation,operation));
  for(const status of routineStatusSchema.options)rows.push(row("routine-status",status,status));
  rows.push(...schemaCases("routine-schedule","routine",schemaJson(routineScheduleSchema)));
  for(const path of paths){
   if(/^lib\/metrics\/core\/[^/]+\.ts$/.test(path)&&!path.includes(".test."))rows.push(...fingerprintedExports(path));
   if(/^app\/\[locale\]\/.*page\.tsx$/.test(path)||path==="app/[locale]/page.tsx")rows.push(row("screen-candidate",path,source(path)));
   if(/^lib\/ai\/supervisor\/(routines|runs)\/[^/]+\.ts$/.test(path)&&!path.includes(".test."))rows.push(...fingerprintedExports(path));
   if(/^app\/api\/cron\/[^/]+\/route\.ts$/.test(path))rows.push(row("monitor-candidate",path,source(path)));
  }
  const inventory=makeInventory(rows);
  const manifestPaths=paths.filter(p=>p.startsWith(".github/luna/scenarios/")&&p.endsWith(".json"));
  const manifests=manifestIndex(root,manifestPaths,coverageMap.legacyTools);
  const report=buildCensusReport(inventory,manifests,{head:git("rev-parse","HEAD"),runId:process.env.GITHUB_RUN_ID??null,deterministicMetrics,testReferences:findTestReferences(new Set(visible.keys()))});
  if(process.env.AICAFE_CENSUS_OUTPUT)writeCensus(process.env.AICAFE_CENSUS_OUTPUT,report);
  expect(report.totals.UNTESTED).toBe(inventory.length);
  expect(report.complete).toBe(false);
  // The omitted memory tool is an explicit independently reviewed addition.
  const expectedMemory=coverageMap.reviewedMemorySchema;
  const actualMemory=schemaJson(memoryTools.remember_cafe_fact.schema);
  expect(actualMemory).toEqual(expectedMemory);
  verifyBootstrapSnapshot(report,{...coverageMap,reviewedAdditions:[
    row("tool",memoryToolDefinition.name,{input:expectedMemory,advertised:true}),
    ...schemaCases("tool-input",memoryToolDefinition.name,expectedMemory),
  ]});
  console.log("Task17B census (discovery only):",JSON.stringify({head:report.head,totals:report.totals,byKind:report.byKind,manifests:report.manifests,unknownManifestTools:report.unknownManifestTools}));
 });

 it("checks each actual registered schema rejects unexpected tenant authority",()=>{
  for(const [name,entry] of Object.entries(fullSchemas)){
   const schema="schema" in entry?entry.schema:entry;
   // Invalid extra authority should not be silently consumed as tool arguments.
   const json=schemaJson(schema);
   expect(json.type,name).toBe("object");
   expect(json.additionalProperties,name).toBe(false);
   expect(schema.safeParse({businessId:"foreign",ownerUserId:"foreign"}).success,name).toBe(false);
  }
 });
 it("dispatches all declared external-content mutation classes through the actual denial gate",async()=>{
  const names=Object.keys(fullSchemas).filter(n=>n.startsWith("propose_")||
   ["draft_week_schedule","record_supplier_order_outcome","record_checkin","remember_cafe_fact","manage_routine","manage_commitment"].includes(n));
  const accessed:string[]=[];
  const context=new Proxy({externalEvidencePresent:()=>true,ownerText:"Read only. Do not change anything."},{
   get(target,prop){if(prop in target)return Reflect.get(target,prop);accessed.push(String(prop));throw Error("unexpected_port_access");}
  }) as unknown as AgentToolContext;
  for(const name of names){
   const result=await executeAgentTool(name,{action:"create"},context);
   expect(result.missing,name).toEqual(["owner_action_confirmation_required"]);
  }
  expect(accessed).toEqual([]);
 });
 it("queries every declared canonical field through the actual scoped query grammar",async()=>{
  const businessId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const rpc=vi.fn(async(_name:string,_input:unknown)=>({data:{rows:[],sourceCount:0},error:null}));
  const ctx={businessId,db:{rpc} as never};
  for(const [view,contract] of Object.entries(canonicalDictionary)){
   const described=await dataQueryTools.describe_data.execute({view,record_type:null,field_prefix:null},ctx);
   expect(described.views,view).toEqual([expect.objectContaining({name:view,columns:expect.arrayContaining(Object.entries(contract.columns).map(([name,c])=>expect.objectContaining({name,unit:c.unit,source:c.source})))})]);
   for(const field of Object.keys(contract.columns)){
    rpc.mockClear();
    const result=await dataQueryTools.query_data.execute({view,columns:[field],filters:null,group_by:null,metrics:null,
     date_from:truth.day.date,date_to:truth.day.date,order_by:null,limit:1},ctx);
    if(view==="cv_toast_records"&&field==="data"){
     expect(result.error).toBe("column_not_allowed");expect(rpc).not.toHaveBeenCalled();continue;
    }
    expect(result.error,view+"."+field).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({p_business_id:businessId,p_view:view,p_columns:expect.arrayContaining([field])}));
   }
  }
 });
 it("checks every pinned official Toast field path is declared schema only, never a granted live value",()=>{
  for(const [family,catalog] of Object.entries(toastOfficialFieldCatalog)){
   // Family-level official schema projection, not an assertion that this
   // endpoint name or any field is actually present in a specific café.
   const fields=officialToastFields(family+"/schema");
   const expected=catalog.fields.filter(([path])=>isDataField(path)).map(([path,types])=>({field:path,type:types.join("|")}));
   expect(fields.map(({field,type})=>({field,type})),family).toEqual(expected);
   for(const field of fields)expect(field).toMatchObject({source:"official_schema",observed:false,grant:"not_verified",schema_sha256:catalog.sha256});
  }
 });
 it("rejects independent forbidden nested credential examples before any database read",async()=>{
  const forbidden=["data.access_token","data.customer.cardNumber","data.checks.0.payments.0.cardDetails","data.clientSecret","data.password","data.paymentToken","data.bankAccountNumber"];
  const rpc=vi.fn(async()=>{throw Error("credential_read_attempt");});
  const ctx={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",db:{rpc} as never};
  for(const column of forbidden){
   const result=await dataQueryTools.query_data.execute({view:"cv_toast_records",columns:[column],filters:null,group_by:null,metrics:null,
    date_from:truth.day.date,date_to:truth.day.date,order_by:null,limit:1},ctx);
   expect(result.error,column).toBe("column_not_allowed");
  }
  expect(rpc).not.toHaveBeenCalled();
 });
});

// Separate, explicitly selected required DB lane. The ordinary deterministic
// suite never connects to a database or obtains provider credentials.
if(process.env.AICAFE_CENSUS_DISPOSABLE_DB==="1"){
 it("actual migrated canonical SQL views, named paths and two-owner RLS match the registered dictionary",async()=>{
  const db=new Client({host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres",connectionTimeoutMillis:5000});
  await db.connect();
  try{
   await db.query("BEGIN READ ONLY");
   const catalog=await db.query("select table_name,column_name from information_schema.columns where table_schema='public' and table_name=any($1::text[])",[[...canonicalViewNames]]);
   const views=await db.query("select c.relname,c.reloptions,pg_get_viewdef(c.oid,true) definition from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v' and c.relname=any($1::text[])",[[...canonicalViewNames]]);
   const verifiedViews=[];
   for(const [name,contract] of Object.entries(canonicalDictionary)){
    const columns=catalog.rows.filter(r=>r.table_name===name).map(r=>String(r.column_name)).sort();
    expect(columns,name+" dictionary columns").toEqual(Object.keys(contract.columns).sort());
    const view=views.rows.find(r=>r.relname===name);
    expect(view?.reloptions,name+" invoker").toContain("security_invoker=true");
    expect(view?.definition,name+" no diagnostic fallback").not.toMatch(/toast_raw_samples(?:_latest)?/i);
    verifiedViews.push(name);
   }
   const functions=await db.query("select proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=any($1::text[])",[["ai_query_view","ai_toast_fields","toast_records_for"]]);
   for(const name of ["ai_query_view","ai_toast_fields","toast_records_for"]){
    const definitions=functions.rows.filter(r=>r.proname===name);
    expect(definitions.length,name).toBeGreaterThan(0);
    for(const d of definitions)expect(d.definition,name+" no diagnostic fallback").not.toMatch(/toast_raw_samples(?:_latest)?/i);
   }
   const paths=[...new Set(Object.values(toastOfficialFieldCatalog).flatMap(f=>f.fields.map(([field])=>field)))];
   const forbidden=["data.access_token","data.checks.0.payments.0.cardNumber","data.customer.client_secret","data.paymentToken","data.password"];
   const checked=await db.query("select field,public.ai_query_path(field) is not null as allowed from unnest($1::text[]) as fields(field)",[[...paths,...forbidden]]);
   for(const field of checked.rows){
    expect(field.allowed,field.field+" SQL/TS path parity").toBe(isDataField(field.field));
    if(forbidden.includes(field.field))expect(field.allowed,field.field).toBe(false);
   }
   const profiles=TEST_CAFES.slice(0,2);
   expect(profiles).toHaveLength(2);
   const identity=profiles.map(c=>({businessId:c.businessId!,ownerId:c.owner!.userId}));
   expect(identity[0].businessId).not.toBe(identity[1].businessId);
   let positiveRows=0,foreignNegatives=0,queries=0;
   for(const [index,cafe] of identity.entries()){
    const other=identity[1-index];
    const day=(await db.query("select max(business_date)::text as day from public.daily_rollups where business_id=$1",[cafe.businessId])).rows[0]?.day;
    expect(day,"seeded closed day").toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await db.query("SAVEPOINT scoped_owner");
    try{
     await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[cafe.ownerId,JSON.stringify({sub:cafe.ownerId,role:"authenticated"})]);
     await db.query("SET LOCAL ROLE authenticated");
     for(const [name,contract] of Object.entries(canonicalDictionary)){
      // Same RPC the registered tool uses. Never retrieve full Toast JSON.
      // Query every allowed column in chunks within the 20-column bound.
      const fields=Object.keys(contract.columns).filter(c=>c!=="business_id"&&!(name==="cv_toast_records"&&c==="data"));
      for(let offset=0;offset<fields.length;offset+=19){
       const selected=["business_id",...fields.slice(offset,offset+19)];
       const q="select public.ai_query_view($1,$2,$3::text[],'[]'::jsonb,null,'[]'::jsonb,$4::date,$4::date,null,1) as got";
       const own=(await db.query(q,[cafe.businessId,name,selected,day])).rows[0].got;
       expect(Array.isArray(own.rows),name+" result").toBe(true);
       for(const result of own.rows){
        expect(result.business_id,name+" owner scope").toBe(cafe.businessId);
        expect(Object.keys(result).sort(),name+" projected field set").toEqual(selected.sort());
        positiveRows++;
       }
       const denied=(await db.query(q,[other.businessId,name,selected,day])).rows[0].got;
       expect(denied.rows,name+" foreign owner rows").toEqual([]);
       expect(Number(denied.sourceCount),name+" foreign row count").toBe(0);
       foreignNegatives++;queries++;
      }
     }
    }finally{
     await db.query("ROLLBACK TO SAVEPOINT scoped_owner");
     await db.query("RELEASE SAVEPOINT scoped_owner");
    }
   }
   // Some configured sources legitimately have no records in these synthetic
   // cafés. A working SQL projection/denial is not a live-data receipt.
   expect(positiveRows,"actual owner rows, not only emptiness").toBeGreaterThan(0);
   const proof={head:git("rev-parse","HEAD"),views:verifiedViews,declaredColumns:catalog.rowCount,officialPathChecks:checked.rowCount,
    ownerProjectionQueries:queries,ownerRowsObserved:positiveRows,foreignZeroRowChecks:foreignNegatives,
    providerModelProof:false,liveToastProof:false,scope:"active_migrated_schema_and_scoped_projection_only"};
   console.log("Task17B migrated canonical proof:",JSON.stringify(proof));
   if(process.env.AICAFE_CENSUS_DB_OUTPUT)writeCensus(process.env.AICAFE_CENSUS_DB_OUTPUT,proof);
  }finally{
   try{await db.query("ROLLBACK");}finally{await db.end();}
  }
 },120000);
}
