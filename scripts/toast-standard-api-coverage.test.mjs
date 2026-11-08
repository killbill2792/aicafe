#!/usr/bin/env node
/**
 * POS0a READ-ONLY contract audit. No provider calls, database writes or runtime imports.
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

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=path=>readFileSync(resolve(root,path),"utf8");
const manifest=JSON.parse(read("docs/plans/toast-openapi-spec-snapshot.json"));
const matrix=read("docs/plans/toast-standard-api-coverage-matrix.md");
const registrySource=read("lib/pos/toast/rawSample.server.ts");
const registryLiteral=registrySource.match(/export const TOAST_READ_ENDPOINTS:readonly Entry\[\]=(\[[^\r\n]+\]);/);
assert.ok(registryLiteral,"Existing Toast endpoint registry is readable; no second registry");
const liveRegistry=JSON.parse(registryLiteral[1]);
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
});
