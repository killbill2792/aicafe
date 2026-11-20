import {readFileSync,writeFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
const matrix=JSON.parse(readFileSync(new URL("../../tests/e2e/task17d-owner-matrix.json",import.meta.url),"utf8"));

export function verifyOwnerCases(report, contract=matrix, selected=null) {
  const expected=new Set();
  for(const c of contract.cases.filter(c=>!selected||selected.includes(c.tag??"home"))) for(const w of c.viewports??contract.viewports) {
    const key=c.id+"-"+w;
    if(expected.has(key)) throw Error("Duplicate owner matrix case "+key);
    expected.add(key);
  }
  if(!contract.cases.length||!contract.viewports.length)throw Error("Empty 17D matrix");
  const inherited=(contract.inheritedCases??[]).filter(c=>!selected||selected.includes(c.tag));
  if(!expected.size&&!inherited.length) return {status:"not_selected",expected:0,cases:[],errors:[],integrated_proven:false,live_model_proof:false};
  const observed=new Map(), errors=[];
  function walk(suite) {
    for(const spec of suite.specs??[]) {
      const match=spec.title?.match(/(?:^|\s)17D:(D\d{2}-\d+)(?:\s|$)/);
      if(!match)continue;
      const id=match[1], tests=spec.tests??[];
      if(!expected.has(id))errors.push("unmapped:"+id);
      if(observed.has(id)||tests.length!==1)errors.push("duplicate-or-empty:"+id);
      const t=tests[0];
      const ok=t?.status==="expected"&&t.expectedStatus==="passed"&&
        t.results?.length===1&&t.results[0].status==="passed";
      observed.set(id,ok);
      if(!ok)errors.push("not-passed:"+id);
    }
    for(const child of suite.suites??[])walk(child);
  }
  for(const suite of report?.suites??[])walk(suite);
  for(const id of expected)if(!observed.has(id))errors.push("missing:"+id);
  const inheritedObserved=new Map(),inheritedTitles=new Set(inherited.map(c=>c.title));
  if(inheritedTitles.size!==inherited.length)throw Error("Duplicate inherited browser title");
  function walkInherited(suite){
    for(const spec of suite.specs??[]){
      if(!inheritedTitles.has(spec.title))continue;
      const tests=spec.tests??[],t=tests[0];
      const ok=tests.length===1&&t?.status==="expected"&&t.expectedStatus==="passed"&&t.results?.length===1&&t.results[0].status==="passed";
      if(inheritedObserved.has(spec.title))errors.push("duplicate-inherited:"+spec.title);
      inheritedObserved.set(spec.title,ok);
      if(!ok)errors.push("not-passed-inherited:"+spec.title);
    }
    for(const child of suite.suites??[])walkInherited(child);
  }
  for(const suite of report?.suites??[])walkInherited(suite);
  for(const c of inherited)if(!inheritedObserved.has(c.title))errors.push("missing-inherited:"+c.title);

  return {status:errors.length?"failed":"passed",expected:expected.size,
    cases:[...expected].map(id=>({id,status:observed.get(id)===true?"passed":observed.has(id)?"failed":"untested"})),
    inherited:inherited.map(c=>({title:c.title,status:inheritedObserved.get(c.title)===true?"passed":inheritedObserved.has(c.title)?"failed":"untested"})),
    errors,integrated_proven:false,live_model_proof:false};
}

// Consume the actual 17B inventory and 17C declared operating families.
// Discovery, candidate references and deterministic browser cases are not
// independent owner-facing integrated proof. New or removed IDs stay visible.
export function assessCensus(census, families, contract=matrix) {
  if(!/^[a-f0-9]{40}$/.test(census?.head??"")||
     !Array.isArray(census?.rows)||!census.rows.length||
     !Array.isArray(families)||!families.length||new Set(families).size!==families.length)
    throw Error("Missing upstream acceptance inventory");
  const ids=new Set(),cases=new Set(contract.cases.map(c=>c.id));
  const validRefs=refs=>{
    if(!Array.isArray(refs)||refs.some(x=>!cases.has(x)&&x!=="luna:17d"))
      throw Error("Unknown browser case reference");
    return refs;
  };
  const map=contract.censusCandidates??{},autonomy=contract.autonomyCandidates??{};
  const rows=census.rows.map(r=>{
    if(!r?.id||r.id!==r.kind+":"+r.key||ids.has(r.id)||!/^[a-f0-9]{64}$/.test(r.fingerprint??""))
      throw Error("Invalid upstream census row");
    ids.add(r.id);
    const candidateCases=validRefs(map[r.id]??[]);
    return {id:r.id,fingerprint:r.fingerprint,candidateCases,status:"UNTESTED",
      reason:candidateCases.length?"independently_executed_owner_parity_not_reconciled":"no_owner_browser_mapping_reviewed"};
  });
  for(const f of families)if(typeof f!=="string"||!f)throw Error("Invalid autonomy family");
  const autonomyRows=families.map(id=>({id,candidateCases:validRefs(autonomy[id]??[]),status:"UNTESTED",
    reason:"real_autonomous_receipt_and_owner_browser_match_not_reconciled"}));
  const staleMappings=[...Object.keys(map).filter(id=>!ids.has(id)),
    ...Object.keys(autonomy).filter(id=>!families.includes(id)).map(id=>"autonomy:"+id)];
  const routeReview=contract.routeReview??{};
  const screens=rows.filter(r=>r.id.startsWith("screen-candidate:")).map(r=>{
    const path=r.id.slice("screen-candidate:".length),review=routeReview[path];
    return {id:r.id,classification:review?.state??"gap_unclassified",
      cases:validRefs(review?.cases??[]),remaining:review?.remaining??"new route requires owner review",status:"UNTESTED"};
  });
  const missingRouteReviews=screens.filter(r=>r.classification==="gap_unclassified").map(r=>r.id);
  const retiredRouteReviews=Object.keys(routeReview).filter(path=>!ids.has("screen-candidate:"+path));
  return {head:census.head,inventoryDigest:census.inventoryDigest??null,
    screens,missingRouteReviews,retiredRouteReviews,
    rows,autonomyRows,staleMappings,
    unmapped:rows.filter(r=>!r.candidateCases.length).length,
    unmappedAutonomy:autonomyRows.filter(r=>!r.candidateCases.length).length,
    integrated_proven:false,live_model_proof:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [mode,input,output]=process.argv.slice(2);
  if(mode!=="census"||!input||!output)throw Error("Usage: task17d-evidence.mjs census input output");
  const {requiredFamilies}=await import("../../evals/acceptance/live/task17c-oracle.mjs");
  const census=JSON.parse(readFileSync(input,"utf8"));
  if(!process.env.HEAD_SHA||census.head!==process.env.HEAD_SHA)throw Error("Census is not exact-head");
  const proof=assessCensus(census,requiredFamilies);
  writeFileSync(output,JSON.stringify(proof,null,2)+"\n");
  console.log("17D owner coverage gaps: "+JSON.stringify({rows:proof.rows.length,unmapped:proof.unmapped,
    autonomy:proof.autonomyRows.length,unmappedAutonomy:proof.unmappedAutonomy,staleMappings:proof.staleMappings,
    integrated_proven:false}));
}
