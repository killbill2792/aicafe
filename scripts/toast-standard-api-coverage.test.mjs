#!/usr/bin/env node
/**
 * POS0a READ-ONLY contract audit. No provider calls or database writes; the registry export is evaluated in an isolated sandbox.
 *
 * Default: verifies the pinned official GET/response schema and historical
 * diagnostic observations. PASS DOES NOT establish current café/AI coverage.
 *
 * Full exit gate: POS0A_REQUIRE_FULL_COVERAGE=1 node --test scripts/toast-standard-api-coverage.test.mjs
 * This must fail until official machine-readable Toast specifications, complete
 * nested response schemas and scope/reader evidence are supplied. Do not weaken
 * it, invent a spec digest or equate an October sample with a current source.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=path=>readFileSync(resolve(root,path),"utf8");
const manifest=JSON.parse(read("docs/plans/toast-openapi-spec-snapshot.json"));
const matrix=read("docs/plans/toast-standard-api-coverage-matrix.md");

/**
 * Execute the real exported registry under an isolated, read-only TypeScript
 * module boundary. Compile the module normally, not via matching its source
 * spelling; deny operational imports so this audit never opens a Toast client,
 * admin database connection, or scheduled capture. This is behavior-level
 * inspection of the exported value, not a source-code grep.
 */
function loadToastReadRegistry(){
 const require=createRequire(import.meta.url);
 const ts=require("typescript");
 const source=read("lib/pos/toast/rawSample.server.ts");
 const result=ts.transpileModule(source,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
  esModuleInterop:true,isolatedModules:true
 }});
 const blocked=label=>()=>{throw Error("POS0a test must not execute operational import: "+label);};
 const stub=label=>new Proxy(Object.create(null),{
  get(_target,key){return key==="__esModule"?true:blocked(label+"."+String(key));}
 });
 const safeRequire=id=>{
  if(id==="server-only")return Object.freeze({});
  if(id==="zod"||id==="node:crypto"||id==="date-fns-tz")return require(id);
  if(["@/lib/supabase/admin","./client","./analyticsClient","./redact"].includes(id))
   return stub(id);
  throw Error("Unexpected import from Toast registry module: "+id);
 };
 const sandboxModule={exports:{}};
 runInNewContext(result.outputText,{module:sandboxModule,exports:sandboxModule.exports,require:safeRequire,
  process:Object.freeze({env:Object.freeze({})})},{timeout:3000,filename:"rawSample.server.audit.cjs"});
 const actual=sandboxModule.exports.TOAST_READ_ENDPOINTS;
 assert.ok(Array.isArray(actual),"Real exported TOAST_READ_ENDPOINTS array exists");
 // VM realms have distinct Array prototypes; compare serialized public facts.
 return JSON.parse(JSON.stringify(actual));
}
const liveRegistry=loadToastReadRegistry();
const candidateKey=x=>[x.endpoint,x.path,x.doc,x.scope,Boolean(x.page),x.source??""].join("\u0000");

function observedLedger(){
 const start=matrix.indexOf("### Historical observed endpoint/path list");
 const end=matrix.indexOf("## Current official response fields",start);
 assert.ok(start>=0&&end>start,"Normalized historical evidence section still exists");
 const part=matrix.slice(start,end);
 return part.split("\n").filter(x=>x.startsWith("| `")).map(line=>{
  const c=line.split("|").slice(1,-1).map(s=>s.trim());
  assert.equal(c.length,3,"Every observed row has endpoint/path/contract code");
  return c;
 });
}
function legendCodes(){
 const start=matrix.indexOf("### Historical observation contract legend");
 const end=matrix.indexOf("### Historical observed endpoint/path list",start);
 assert.ok(start>=0&&end>start,"Shared historical contract legend exists");
 return new Set(matrix.slice(start,end).split("\n").map(line=>/^\| (H\d+) \|/.exec(line)?.[1]).filter(Boolean));
}
test("Pinned official schema provenance remains distinct from current café/AI proof",()=>{
 assert.equal(manifest.schema_version,2);
 assert.equal(manifest.classification,"PINNED_OFFICIAL_GET_SCHEMA__CURRENT_CAFE_AND_READER_UNVERIFIED");
 assert.equal(manifest.coverage_complete,false);
 assert.ok(manifest.official_scopes_reference.startsWith("https://doc.toasttab.com/"));
 assert.ok(manifest.official_families.length>0);
 const ids=manifest.official_families.map(x=>x.family);
 assert.equal(ids.length,new Set(ids).size,"One provenance row per family");
 for(const f of manifest.official_families){
  assert.ok(f.official_overview.startsWith("https://doc.toasttab.com/openapi/"),f.family);
  assert.equal(f.status,"OFFICIAL_SCHEMA_DOWNLOADED__CURRENT_GRANTS_AND_READER_UNVERIFIED");
  assert.match(f.official_spec_sha256,/^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(f.official_nested_response_fields)&&f.official_nested_response_fields>0);
 }
 assert.ok(manifest.acceptance_gates.A1_official_get_operation_inventory.includes("PINNED"));
 assert.ok(manifest.acceptance_gates.A2_nested_type_scope_field_coverage.includes("OPEN"));
 assert.ok(manifest.acceptance_gates.A4_source_storage_shared_reader_supervisor.startsWith("OPEN_"));
});
test("Recorded registry candidates exactly reflect the existing Toast code, not a new API list",()=>{
 assert.equal(liveRegistry.length,manifest.registry_candidates.length);
 assert.deepEqual(liveRegistry.map(candidateKey),manifest.registry_candidates.map(candidateKey));
 assert.ok(liveRegistry.some(x=>x.endpoint.startsWith("menus/v3/")),"V3 remains explicitly classified, not Standard");
 assert.ok(liveRegistry.some(x=>x.endpoint.startsWith("era/")),"ERA remains separately entitled, not Standard");
 assert.ok(liveRegistry.some(x=>x.endpoint.includes("/no_get_operations")),"No-GET sentinels are explicit");
});
test("All normalized historical redacted paths retain their source endpoint and exact contract legend",()=>{
 const rows=observedLedger();
 const codes=legendCodes();
 assert.equal(rows.length,manifest.historical_redacted_diagnostic.endpoint_field_rows);
 assert.equal(codes.size,manifest.historical_redacted_diagnostic.shared_contracts);
 assert.ok(rows.every(([,path,code])=>path.startsWith("`")&&path.endsWith("`")&&codes.has(code)));
 const pairKeys=rows.map(([endpoint,path])=>endpoint+"\u0000"+path);
 assert.equal(new Set(pairKeys).size,rows.length,"One row per observed endpoint/path pair");
 assert.ok(matrix.includes("October 28")&&matrix.includes("diagnostic"),"Do not present samples as current data");
 assert.ok(matrix.includes("toast_raw_records")&&matrix.includes("toast_raw_changes"),"Existing single-system architecture retained");
});
test("No official GET/field/AI completeness claim is inferred from registry or diagnostic observations",()=>{
 assert.notEqual(manifest.coverage_complete,true);
 assert.equal(manifest.historical_redacted_diagnostic.classification,"OCTOBER_28_ONLY_NOT_OFFICIAL");
 assert.equal(manifest.official_families.filter(x=>x.official_spec_sha256!==null).length,manifest.official_families.length);
 assert.equal(Object.values(manifest.acceptance_gates).filter(v=>v==="VERIFIED").length,0);
});
if(process.env.POS0A_REQUIRE_FULL_COVERAGE==="1"){
 test("A1/A2/A4 STRICT GATE: pinned official OpenAPI + nested fields + real retained/reader proof",()=>{

  assert.equal(manifest.coverage_complete,true,
   "Do not claim full Standard GET/response field scope or reader proof from October diagnostics");
  for(const fam of manifest.official_families){
   assert.match(fam.official_spec_sha256,/^[a-f0-9]{64}$/);
   assert.ok(Array.isArray(fam.official_get_operations));
   assert.ok(Number.isInteger(fam.official_nested_response_fields));
   assert.ok(fam.official_nested_response_fields>0);
  }
  for(const key of ["A1_official_get_operation_inventory","A2_nested_type_scope_field_coverage",
   "A4_source_storage_shared_reader_supervisor"]){
   assert.equal(manifest.acceptance_gates[key],"VERIFIED",key);
  }
 });
}




test("Official 12-family GET/response-field snapshot matches pinned source and every nested record",()=>{
 const snap=manifest.official_snapshot;
 assert.equal(snap.family_count,12);
 assert.equal(snap.get_operation_count,74);
 assert.equal(snap.nested_response_field_rows,2320);
 assert.equal(snap.unresolved_source_refs,0);
 assert.equal(snap.families.length,12);
 assert.match(snap.source_run,/^https:\/\/github\.com\/killbill2792\/aicafe\/actions\/runs\/\d+$/);
 assert.match(snap.source_head_sha,/^[a-f0-9]{40}$/);
 const byFamily=new Map(snap.families.map(f=>[f.family,f]));
 assert.equal(byFamily.size,12);
 let operationCount=0,fieldCount=0;
 for(const metadata of manifest.official_families){
  const f=byFamily.get(metadata.family);
  assert.ok(f,"Official source family missing: "+metadata.family);
  assert.equal(f.overview,metadata.official_overview);
  assert.equal(f.download_url,metadata.official_download_url_verified);
  assert.match(f.download_url,/^https:\/\/doc\.toasttab\.com\/toast-api-specifications\/[^/]+\.yaml$/);
  assert.equal(f.sha256,metadata.official_spec_sha256);
  assert.match(f.sha256,/^[0-9a-f]{64}$/);
  assert.equal(f.version,metadata.overview_version_unpinned);
  assert.deepEqual(f.unresolved_refs,[]);
  assert.deepEqual(f.operations.map(op=>op.path),metadata.official_get_operations);
  let count=0;
  for(const op of f.operations){
   assert.equal(op.method,"GET");
   assert.ok(op.path.startsWith("/"));
   for(const response of op.responses){
    assert.match(response.status,/^2\d\d$/);
    assert.ok(Array.isArray(response.fields));
    const keys=response.fields.map(row=>JSON.stringify(row));
    assert.equal(new Set(keys).size,keys.length,"Duplicate nested field description");
    assert.ok(response.fields.every(row=>row.length===4&&typeof row[0]==="string"&&typeof row[1]==="string"));
    count+=response.fields.length;
   }
   operationCount++;
  }
  assert.equal(count,metadata.official_nested_response_fields);
  fieldCount+=count;
 }
 assert.equal(operationCount,snap.get_operation_count);
 assert.equal(fieldCount,snap.nested_response_field_rows);
});
test("Registry route-prefix differences remain visible rather than auto-resolved",()=>{
 const norm=s=>s.replace(/\/+/g,"/").replace(/\{[^}]+\}/g,"{}").replace(/\/$/,"").toLowerCase();
 const supported=new Set(manifest.official_snapshot.families.map(x=>x.family));
 const registry=liveRegistry.filter(x=>supported.has(x.endpoint.split("/")[0])&&!x.endpoint.startsWith("menus/v3/"));
 const official=manifest.official_snapshot.families.flatMap(f=>f.operations.map(o=>o.path));
 const routes=new Set(registry.map(x=>norm(x.path)));
 const docs=new Set(official.map(norm));
 const missing=registry.filter(x=>!docs.has(norm(x.path))).map(x=>x.path);
 const extra=official.filter(x=>!routes.has(norm(x)));
 const recorded=manifest.official_registry_comparison;
 assert.equal(registry.length,recorded.standard_registry_count);
 assert.equal(official.length,recorded.official_get_count);
 assert.deepEqual(missing,recorded.exact_path_mismatches.in_registry_not_official);
 assert.deepEqual(extra,recorded.exact_path_mismatches.in_official_not_registry);
 assert.deepEqual(missing,["/stock/v1/inventory","/packaging/v1/published/packagingConfig"]);
 assert.deepEqual(extra,["/v1/inventory","/v1/published/packagingConfig"]);
 const classifications=recorded.route_prefix_classification;
 assert.equal(classifications.length,2,"Both Swagger/gateway route distinctions classified from official docs");
 for(const entry of classifications){
  assert.ok(extra.includes(entry.swagger_path),"Each raw Swagger path remains accounted for");
  assert.ok(missing.includes(entry.gateway_path),"Each registry gateway path remains accounted for");
  assert.match(entry.official_operation_page,/^https:\/\/doc\.toasttab\.com\/openapi\/(stock|packaging)\/operation\//);
  assert.equal(entry.status,"CLASSIFIED_OFFICIAL_REQUEST_EXAMPLE_NO_CAFE_FETCH");
  assert.ok(entry.evidence.includes(entry.gateway_path));
 }
 assert.ok(manifest.acceptance_gates.A1_official_get_operation_inventory.includes("CLASSIFIED"));
 assert.ok(manifest.acceptance_gates.A1_official_get_operation_inventory.includes("OPEN"),
  "Official source route evidence does not establish café grant or live response");
});

/**
 * Official source rows are enumerated from the PINNED 2xx snapshot, never the
 * October diagnostic. Family H# contracts describe current writer/reader
 * evidence; most individual current fields remain not_verified. Per-café
 * grant/response remains not_tested even when an October attempt returned 200.
 */
test("Every official nested field has a non-fabricated architecture disposition",()=>{
 const contract=manifest.official_field_resolution;
 assert.equal(contract.version,1);
 const codes=legendCodes();
 const byFamily=new Map(contract.family_contracts.map(x=>[x.family,x]));
 assert.equal(byFamily.size,manifest.official_snapshot.families.length,"One inherited contract per official family");
 assert.equal(contract.family_contracts.length,12,"No missing or duplicated family inheritance");
 for(const value of Object.values(contract.per_cafe_field_defaults))
  assert.ok(["not_tested","not_verified"].includes(value),"Never fabricate current café/field access proof");
 assert.equal(contract.per_cafe_field_defaults.grant,"not_tested");
 assert.equal(contract.per_cafe_field_defaults.response,"not_tested");
 assert.equal(contract.per_cafe_field_defaults.field_queryable,"not_verified");
 assert.equal(contract.per_cafe_field_defaults.registered_supervisor_and_screen,"not_verified");
 const required=["source_scope","object_identity","current_writer_storage","existing_ingest_cadence",
  "current_operational_reader","supervisor_reader","screen_consumer","downstream_owner","known_gap"];
 const rowIds=new Set(),matchedExceptions=new Set();
 const sameOrChild=(field,prefix)=>field===prefix||field.startsWith(prefix+".")||field.startsWith(prefix+"[]");
 function resolve(family,path,status,field){
  const inherited=byFamily.get(family);
  assert.ok(inherited,"Unknown official Standard family: "+family);
  assert.ok(codes.has(inherited.historical_contract),"Unknown H-contract for official source family");
  for(const key of required)
   assert.ok(typeof inherited[key]==="string"&&inherited[key].length>12,
    "Missing current/proposed evidence mapping "+family+"."+key);
  const matches=contract.field_prefix_exceptions
   .filter(e=>e.family===family&&e.operation_path===path&&sameOrChild(field,e.field_prefix))
   .sort((a,b)=>b.field_prefix.length-a.field_prefix.length);
  if(matches.length)matchedExceptions.add(contract.field_prefix_exceptions.indexOf(matches[0]));
  const exception=matches[0]??null;
  const lower=field.toLowerCase();
  const privacy=contract.risk_precedence.find(r=>r.field_segments_or_substrings.length===0||
   r.field_segments_or_substrings.some(part=>lower.includes(part)));
  assert.ok(privacy?.treatment,"No privacy classification: "+family+" "+field);
  if(exception){
   assert.ok(exception.additional_or_required_scope&&exception.privacy_override&&exception.field_gap);
  }
  return {inherited,exception,privacy,source_key:[family,path,status,field].join("|"),
   grant:contract.per_cafe_field_defaults.grant,
   response:contract.per_cafe_field_defaults.response,
   retained:contract.per_cafe_field_defaults.field_retained,
   queryable:contract.per_cafe_field_defaults.field_queryable};
 }
 let count=0;
 for(const family of manifest.official_snapshot.families)
  for(const op of family.operations)
   for(const res of op.responses)
    for(const [field] of res.fields){
     const row=resolve(family.family,op.path,res.status,field);
     assert.ok(!rowIds.has(row.source_key),"Duplicate official family/GET/status/path disposition");
     rowIds.add(row.source_key);
     assert.equal(row.grant,"not_tested");
     assert.equal(row.response,"not_tested");
     assert.equal(row.retained,"not_verified");
     assert.equal(row.queryable,"not_verified");
     count++;
    }
 assert.equal(count,manifest.official_snapshot.nested_response_field_rows);
 assert.equal(rowIds.size,2320);
 assert.equal(matchedExceptions.size,contract.field_prefix_exceptions.length,
  "Each field-specific exception must attach to a real official operation/field");
 const customer=resolve("orders","/orders/v2/ordersBulk","200","[].checks[].customer.email");
 assert.equal(customer.inherited.historical_contract,"H1");
 assert.equal(customer.exception.field_prefix,"[].checks[].customer.email");
 assert.equal(customer.exception.additional_or_required_scope,"guest.pi:read");
 assert.match(customer.exception.privacy_override,/CURRENT_DROP/);
 const identity=resolve("orders","/orders/v2/orders/{guid}","200","checks[].customer.guid");
 assert.match(identity.exception.privacy_override,/HASH_IF_CONFIGURED_ELSE_OMIT/);
 const labor=resolve("labor","/labor/v1/timeEntries","200","[].jobReference.guid");
 assert.equal(labor.inherited.historical_contract,"H4");
 assert.equal(labor.exception.field_prefix,"[].jobReference");
 assert.match(labor.exception.field_gap,/NOT VERIFIED/);
 const stock=resolve("stock","/v1/inventory","200","[].quantity");
 assert.equal(stock.inherited.historical_contract,"H6");
 assert.equal(stock.exception.field_prefix,"[].quantity");
 assert.match(stock.inherited.current_operational_reader,/NO CURRENT OPERATIONAL READER/);
 assert.match(stock.exception.privacy_override,/never replace 403/);
 assert.equal(manifest.coverage_complete,false,
  "Full runtime source→retention→SQL→one-Supervisor gate must remain fail-closed");
 assert.ok(matrix.includes("POS0a A1–A4 architecture acceptance reconciliation"));
 assert.ok(matrix.includes("Official source row → inherited contract → exception"));
});
