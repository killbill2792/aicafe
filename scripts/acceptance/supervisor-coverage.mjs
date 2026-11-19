/** No-secret inventory and conservative acceptance accounting. Candidate-generated
 * inventory is not independent provider proof. Never promote a scenario reference
 * or self-reported model/tool result to a PASS. */
import {createHash} from "node:crypto";
import {existsSync,readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {dirname,resolve,relative,isAbsolute} from "node:path";

function stable(value){
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
 return value;
}
export const fingerprint=value=>createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export function row(kind,key,contract){
 if(typeof kind!=="string"||!kind||typeof key!=="string"||!key)throw Error("invalid_census_identity");
 return {id:kind+":"+key,kind,key,fingerprint:fingerprint(contract)};
}
export function schemaCases(kind,key,schema){
 const rows=[];
 function visit(node,path){
  if(!node||typeof node!=="object")return;
  if(Array.isArray(node)){node.forEach((v,i)=>visit(v,path+"."+i));return;}
  if(Array.isArray(node.enum)){
   for(const v of node.enum)rows.push(row(kind,key+":"+path+"="+JSON.stringify(v),{value:v}));
  }else if(Object.hasOwn(node,"const"))rows.push(row(kind,key+":"+path+"="+JSON.stringify(node.const),{value:node.const}));
  for(const [name,value] of Object.entries(node)){
   if(name==="properties"){
    for(const [field,definition] of Object.entries(value)){
      rows.push(row(kind,key+":"+path+"."+field,definition));
      visit(definition,path+"."+field);
    }
   }else if(!["enum","const","description","examples","default","required"].includes(name))visit(value,path+"."+name);
  }
 }
 visit(schema,"$");
 return rows;
}
export function makeInventory(rows){
 const ids=new Set();
 for(const r of rows){
  if(!r||r.id!==r.kind+":"+r.key||!r.key||!r.kind||!/^[a-f0-9]{64}$/.test(r.fingerprint)||ids.has(r.id))
    throw Error("duplicate_or_invalid_census_row:"+r?.id);
  ids.add(r.id);
 }
 if(!rows.length)throw Error("empty_census");
 return [...rows].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
}
export function manifestIndex(root,paths,legacyTools={}){
 const index=new Map(),ids=new Set();
 for(const path of paths){
  if(!/^\.github\/luna\/scenarios\/[a-z0-9-]+\.json$/.test(path))throw Error("invalid_manifest_path");
  const manifest=JSON.parse(readFileSync(resolve(root,path),"utf8"));
  if(manifest.id!==path.split("/").at(-1).slice(0,-5)||ids.has(manifest.id))throw Error("duplicate_or_invalid_manifest");
  ids.add(manifest.id);
  const entry=manifest.entrypoint;
  if(typeof entry!=="string"||isAbsolute(entry)||relative(root,resolve(root,entry)).startsWith("..")||!existsSync(resolve(root,entry)))
    throw Error("missing_manifest_entrypoint:"+manifest.id);
  for(const tool of manifest.expectedTools??legacyTools[manifest.id]??[]){
   if(typeof tool!=="string"||!tool)throw Error("invalid_manifest_tool");
   const refs=index.get(tool)??[];
   refs.push(manifest.id);index.set(tool,refs);
  }
 }
 return {index,ids:[...ids].sort()};
}
/** A mapping alone never represents an executed test. Bootstrap records every
 * gap; the release check deliberately rejects even one UNTESTED row. */
/** @param {any[]} rows @param {any} manifests
 * @param {{head?:string,runId?:string|null,deterministicMetrics?:string[],testReferences?:Map<string,{path:string,title:string}[]>}} options */
export function buildCensusReport(rows,manifests,{head,runId=null,deterministicMetrics=[],testReferences=new Map()}={}){
 if(!/^[a-f0-9]{40}$/.test(head??""))throw Error("invalid_head");
 const inventory=makeInventory(rows);
 const tools=new Set(inventory.filter(r=>r.kind==="tool").map(r=>r.key));
 const unknownManifestTools=[...manifests.index.keys()].filter(t=>!tools.has(t)).sort();
 const mapped=inventory.map(r=>({...r,
   candidateScenarios:r.kind==="tool"?[...(manifests.index.get(r.key)??[])].sort():[],
   candidateDeterministicCases:r.kind==="tool"?testReferences.get(r.key)??[]:[],
   deterministicMetricOracle:r.kind==="metric"&&deterministicMetrics.includes(r.key)?"PASS":"UNTESTED",
   status:"UNTESTED",reason:"independent_end_to_end_receipt_not_verified"}));
 const byKind={};
 for(const r of mapped){const a=byKind[r.kind]??={PASS:0,FAIL:0,UNTESTED:0,UNSUPPORTED:0};a[r.status]++;}
 return {schemaVersion:1,head,runId,providerModelProof:false,complete:false,
  manifests:manifests.ids,unknownManifestTools,totals:{PASS:0,FAIL:0,UNTESTED:mapped.length,UNSUPPORTED:0},
  byKind,inventoryDigest:fingerprint(inventory),rows:mapped};
}
export function inventoryDelta(previous,current){
 const p=new Map(makeInventory(previous).map(r=>[r.id,r]));
 const c=new Map(makeInventory(current).map(r=>[r.id,r]));
 return {added:[...c.keys()].filter(id=>!p.has(id)),removed:[...p.keys()].filter(id=>!c.has(id)),
 changed:[...c.keys()].filter(id=>p.has(id)&&p.get(id).fingerprint!==c.get(id).fingerprint)};
}
/** Freeze the initial outstanding inventory; a change requires review.
 * This never grants acceptance to the baseline gaps. */
export function verifyBootstrapSnapshot(report,mapping){
 // A separately reviewed addition is an explicit contract, not a blanket
 // permission to reset the baseline hash. Compare old rows unchanged.
 const additions=mapping?.reviewedAdditions??[];
 const ids=new Set(additions.map(r=>r.id));
 const actual=report.rows.filter(r=>ids.has(r.id)).map(({id,kind,key,fingerprint})=>({id,kind,key,fingerprint}));
 const baseline=report.rows.filter(r=>!ids.has(r.id)).map(({id,kind,key,fingerprint})=>({id,kind,key,fingerprint}));
 if(mapping?.schemaVersion!==1||mapping?.baselineInventoryDigest!==fingerprint(makeInventory(baseline))||
  mapping?.baselineRows!==baseline.length||report.unknownManifestTools?.length||
  (additions.length>0&&(actual.length!==additions.length||fingerprint(makeInventory(actual))!==fingerprint(makeInventory(additions)))))
   throw Error("supervisor_coverage_drift: review newly added/removed/changed rows and executable oracles; census artifact is available");
}
export function requireComplete(report){
 if(!report||!Array.isArray(report.rows)||!report.rows.length||
 report.complete!==true||report.providerModelProof!==true||report.unknownManifestTools?.length||
 report.rows.some(r=>r.status!=="PASS"&&r.status!=="UNSUPPORTED"))
   throw Error("supervisor_acceptance_not_proven");
 // A mutable candidate report cannot establish trusted-provider provenance.
 // Until independent exact-head receipt reconciliation is integrated, fail closed.
 throw Error("supervisor_acceptance_not_proven:trusted_receipt_reconciliation_pending");
}
export function writeCensus(path,report){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(report,null,2)+"\n",{mode:0o600});}
