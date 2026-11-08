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
import {createRequire} from "node:module";

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
 * TEMPORARY read-only public documentation extraction for the owner-approved
 * pinned official schema snapshot. No café credentials or POS API calls.
 * Output is a normalized GET and nested-response field list and original
 * download SHA; all delivery is diagnostic, not full A1/A2/A4 certification.
 * Once collected, replace this with a deterministic pinned-snapshot guard.
 */
test("official-source schema capture (diagnostic, not an acceptance gate)",async t=>{
 const require=createRequire(import.meta.url);
 let yaml;
 try {yaml=require("js-yaml");}
 catch {return t.skip("Pinned local dependency js-yaml unavailable");}
 const errors=[];
 const downloaded=[];
 const fetchWithTimeout=async(url,timeout=15000)=>{
  const res=await fetch(url,{signal:AbortSignal.timeout(timeout)});
  if(!res.ok)throw Error("HTTP "+res.status+" "+url);
  return res;
 };
 const trace=(doc,schema,rootLabel,paths,missing)=>{
  const found=new Map();
  const emit=(p,kind,format="",required=false)=> {
   if(!p)return;
   const key=[p,kind,format,required?1:0].join("|");
   found.set(key,[p,kind,format,required?1:0]);
  };
  const resolveRef=(ref)=>{
   if(typeof ref!=="string"||!ref.startsWith("#/")){missing.add(String(ref));return null;}
   let v=doc;
   for(const token of ref.slice(2).split("/")){
    const part=token.replace(/~1/g,"/").replace(/~0/g,"~");
    v=v?.[part];
   }
   if(!v)missing.add(ref);
   return v??null;
  };
  const walk=(node,p,required=false,depth=0,stack=new Set())=>{
   if(!node||typeof node!=="object"||depth>60){if(depth>60)missing.add("DEPTH "+p);return;}
   if(node.$ref){
    if(stack.has(node.$ref)){emit(p,"recursive_ref",node.$ref,required);return;}
    const ref=node.$ref, target=resolveRef(ref);
    if(target)walk(target,p,required,depth+1,new Set([...stack,ref]));
    return;
   }
   for(const branch of ["allOf","oneOf","anyOf"])if(Array.isArray(node[branch])){
    for(const child of node[branch])walk(child,p,required,depth+1,stack);
   }
   const kind=node.type||(node.properties||node.additionalProperties?"object":"unspecified");
   if(p)emit(p,kind,node.format||"",required);
   if(kind==="array"||node.items){
    const a=node.items;
    if(a)walk(a,p+"[]",required,depth+1,stack);
   }
   if(node.properties&&typeof node.properties==="object"){
    const req=new Set(node.required||[]);
    for(const [name,child] of Object.entries(node.properties)){
     walk(child,p?p+"."+name:name,req.has(name),depth+1,stack);
    }
   }
   if(node.additionalProperties&&typeof node.additionalProperties==="object"){
    walk(node.additionalProperties,p?p+".{*}":"{*}",false,depth+1,stack);
   }
  };
  walk(schema,rootLabel,false,0,new Set());
  return [...found.values()].sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));
 };
 const collect=async family=>{
  try{
   const overview=await (await fetchWithTimeout(family.official_overview)).text();
   const anchors=[...overview.matchAll(/href=["']([^"']*\/toast-api-specifications\/[^"']+\.ya?ml)["']/g)];
   let schemaUrl=family.official_download_url_verified||anchors[0]?.[1];
   if(!schemaUrl)throw Error("No official YAML download href");
   const url=new URL(schemaUrl,family.official_overview);
   if(url.protocol!=="https:"||url.hostname!=="doc.toasttab.com")
    throw Error("Unexpected YAML host "+url.hostname);
   const response=await fetchWithTimeout(url.href,20000);
   const bytes=new Uint8Array(await response.arrayBuffer());
   if(bytes.length<1000)throw Error("Short YAML response");
   const digest=createHash("sha256").update(bytes).digest("hex");
   const text=new TextDecoder().decode(bytes);
   const parsed=yaml.load(text,{json:true});
   if(!parsed?.paths||!parsed.info?.version)throw Error("Invalid parsed official spec");
   const base=parsed.basePath||"";
   const unresolved=new Set(),operations=[];
   for(const [path,methods] of Object.entries(parsed.paths)){
    if(!methods||!methods.get)continue;
    const def=methods.get;
    const responses=[];
    for(const [status,res] of Object.entries(def.responses||{})){
     if(!/^2\d\d$/.test(status)||!res)continue;
     let result=res;
     if(result.$ref&&result.$ref.startsWith("#/")){
      result=result.$ref.slice(2).split("/").reduce((a,k)=>a?.[k],parsed)||{};
     }
     const schema=result.schema||(result.content?.["application/json"]?.schema);
     if(schema)responses.push({status,fields:trace(parsed,schema,"",[],unresolved)});
     else responses.push({status,fields:[]});
    }
    operations.push({path:base+path,method:"GET",operation_id:def.operationId||null,
     security:def.security??parsed.security??null,responses});
   }
   operations.sort((a,b)=>a.path.localeCompare(b.path));
   return {family:family.family,overview:family.official_overview,
    download_url:url.href,sha256:digest,raw_bytes:bytes.length,
    version:String(parsed.info.version),spec_type:parsed.swagger?"swagger "+parsed.swagger:parsed.openapi?"openapi "+parsed.openapi:"unknown",
    operations,unresolved_refs:[...unresolved].sort()};
  }catch(err){
   errors.push({family:family.family,error:err instanceof Error?err.message:String(err)});
   return null;
  }
 };
 const families=manifest.official_families;
 for(let at=0;at<families.length;at+=4){
  const batch=await Promise.all(families.slice(at,at+4).map(collect));
  downloaded.push(...batch.filter(Boolean));
 }
 const snapshot={provenance:"official Toast download URLs; parsed in CI without provider credentials",
  timestamp_utc:new Date().toISOString(),families:downloaded,fetch_errors:errors,
  complete_downloads:downloaded.length===families.length};
 const serial=JSON.stringify(snapshot);
 const chunkSize=5500, count=Math.ceil(serial.length/chunkSize);
 t.diagnostic("POS0A_SCHEMA_CAPTURE_SUMMARY "+JSON.stringify({
  downloaded:downloaded.map(x=>({family:x.family,version:x.version,sha256:x.sha256,raw_bytes:x.raw_bytes,
   operations:x.operations.length,field_rows:x.operations.reduce((s,o)=>s+o.responses.reduce((a,r)=>a+r.fields.length,0),0),
   unresolved_refs:x.unresolved_refs.length})),
  errors,serial_characters:serial.length,chunks:count
 }));
 for(let i=0;i<count;i++)t.diagnostic("POS0A_SCHEMA_CAPTURE_CHUNK "+i+"/"+count+" "+serial.slice(i*chunkSize,(i+1)*chunkSize));
 if(!downloaded.length)t.skip("No public official YAML could be retrieved; do not certify completeness");
});
