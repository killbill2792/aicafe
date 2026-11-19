import {readFileSync} from "node:fs";
const matrix=JSON.parse(readFileSync(new URL("../../tests/e2e/task17d-owner-matrix.json",import.meta.url),"utf8"));

export function verifyOwnerCases(report, contract=matrix, selected=null) {
  const expected=new Set();
  for(const c of contract.cases.filter(c=>!selected||selected.includes(c.tag??"home"))) for(const w of contract.viewports) {
    const key=c.id+"-"+w;
    if(expected.has(key)) throw Error("Duplicate owner matrix case "+key);
    expected.add(key);
  }
  if(!contract.cases.length||!contract.viewports.length)throw Error("Empty 17D matrix");
  if(!expected.size) return {status:"not_selected",expected:0,cases:[],errors:[],integrated_proven:false,live_model_proof:false};
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
  return {status:errors.length?"failed":"passed",expected:expected.size,
    cases:[...expected].map(id=>({id,status:observed.get(id)===true?"passed":observed.has(id)?"failed":"untested"})),
    errors,integrated_proven:false,live_model_proof:false};
}
