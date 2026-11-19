import {describe,it,expect} from "vitest";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import ts from "typescript";
import {z} from "zod";
import {schemas,agentToolDefinitions,investigationToolDefinition,gmailToolDefinitions} from "@/lib/ai/agent/tools";
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
  const visible=new Map([...agentToolDefinitions,...gmailToolDefinitions,investigationToolDefinition,routineToolDefinition].map(t=>[t.name,t]));
  const rows=Object.entries(schemas).flatMap(([name,entry])=>{
   const schema="schema" in entry?entry.schema:entry;
   const json=schemaJson(schema);
   return [row("tool",name,{input:json,advertised:visible.has(name)}),...schemaCases("tool-input",name,json)];
  });
  for(const name of visible.keys())expect(Object.hasOwn(schemas,name)).toBe(true);
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
  const report=buildCensusReport(inventory,manifests,{head:git("rev-parse","HEAD"),runId:process.env.GITHUB_RUN_ID??null,deterministicMetrics});
  if(process.env.AICAFE_CENSUS_OUTPUT)writeCensus(process.env.AICAFE_CENSUS_OUTPUT,report);
  expect(report.totals.UNTESTED).toBe(inventory.length);
  expect(report.complete).toBe(false);
  verifyBootstrapSnapshot(report,coverageMap);
  console.log("Task17B census (discovery only):",JSON.stringify({head:report.head,totals:report.totals,byKind:report.byKind,manifests:report.manifests,unknownManifestTools:report.unknownManifestTools}));
 });
});
