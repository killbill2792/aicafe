#!/usr/bin/env node
/**
 * POS0a READ-ONLY contract audit. No provider calls, database writes or runtime imports.
 *
 * Default: verifies that an incomplete official-source manifest and the exact
 * historical diagnostic ledger remain intact. PASS IS NOT A1/A2/A4 proof.
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
import {createHash} from "node:crypto";

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
test("Source-acquisition metadata clearly refuses to claim a pinned official spec",()=>{
 assert.equal(manifest.schema_version,1);
 assert.equal(manifest.classification,"INCOMPLETE_OFFICIAL_SPEC_EVIDENCE");
 assert.equal(manifest.coverage_complete,false);
 assert.ok(manifest.official_scopes_reference.startsWith("https://doc.toasttab.com/"));
 assert.ok(manifest.official_families.length>0);
 const ids=manifest.official_families.map(x=>x.family);
 assert.equal(ids.length,new Set(ids).size,"One provenance row per family");
 for(const f of manifest.official_families){
  assert.ok(f.official_overview.startsWith("https://doc.toasttab.com/openapi/"),f.family);
  assert.equal(f.status,"OFFICIAL_YAML_NOT_PINNED");
  assert.equal(f.official_spec_sha256,null,"Do not counterfeit a verified official YAML SHA");
  assert.equal(f.official_nested_response_fields,null,"Unknown must not be a guessed field count");
 }
 assert.ok(manifest.acceptance_gates.A1_official_get_operation_inventory.startsWith("OPEN_"));
 assert.ok(manifest.acceptance_gates.A2_nested_type_scope_field_coverage.startsWith("OPEN_"));
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
 assert.equal(manifest.official_families.filter(x=>x.official_spec_sha256!==null).length,0);
 assert.equal(Object.values(manifest.acceptance_gates).filter(v=>v==="VERIFIED").length,0);
});
if(process.env.POS0A_REQUIRE_FULL_COVERAGE==="1"){
 test("A1/A2/A4 STRICT GATE: pinned official OpenAPI + nested fields + real retained/reader proof",()=>{
  assert.equal(manifest.classification,"PINNED_OFFICIAL_OPENAPI_COMPLETE",
   "Official downloaded YAML/JSON with authenticated source and SHA-256 has not been supplied");
  assert.equal(manifest.coverage_complete,true,
   "Do not claim full Standard GET/response field scope or reader proof from October diagnostics");
  for(const fam of manifest.official_families){
   assert.match(fam.official_spec_sha256,/^[a-f0-9]{64}$/);
   assert.ok(Array.isArray(fam.official_get_operations));
   assert.ok(Array.isArray(fam.official_nested_response_fields));
   assert.ok(fam.official_nested_response_fields.length>0);
  }
  for(const key of ["A1_official_get_operation_inventory","A2_nested_type_scope_field_coverage",
   "A4_source_storage_shared_reader_supervisor"]){
   assert.equal(manifest.acceptance_gates[key],"VERIFIED",key);
  }
 });
}


/**
 * A read-only, NON-GATING public-documentation probe. Unlike the four
 * deterministic assertions above, it depends on network availability.
 * Even if the download succeeds, this does NOT satisfy official recursive
 * response-field coverage or any café permission/current-reader proof.
 */
test("official-source reachability probe (not A1/A2/A4 certification)",async t=>{
 const f=manifest.official_families.find(x=>x.family==="orders");
 const url=f?.official_download_url_verified;
 if(!url)return t.skip("No documented official schema URL");
 try{
  const response=await fetch(url,{signal:AbortSignal.timeout(12000)});
  if(!response.ok)return t.skip("Official public YAML HTTP "+response.status);
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length<1000)return t.skip("Source response too small to certify as specification");
  const digest=createHash("sha256").update(bytes).digest("hex");
  assert.match(digest,/^[a-f0-9]{64}$/);
  t.diagnostic("POS0A_PUBLIC_SPEC_RETRIEVAL "+JSON.stringify({
   url,sha256:digest,bytes:bytes.length,
   content_type:response.headers.get("content-type"),
   first_line:new TextDecoder().decode(bytes.slice(0,160)).split("\n")[0]
  }));
 }catch(err){
  t.skip("Public source retrieval unavailable: "+(err instanceof Error?err.message:String(err)));
 }
});
