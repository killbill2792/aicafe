/* eslint-disable @typescript-eslint/no-require-imports -- Promptfoo loads file-backed assertions as CommonJS. */
// Promptfoo file-backed JS assertions. The expected values are withheld from
// the provider's owner message and are independent of the agent's calculations.
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const seed = JSON.parse(readFileSync(join(__dirname,"seed.json"),"utf8"));
const replays=JSON.parse(readFileSync(join(__dirname,"replays.json"),"utf8")).cases;
function decoded(output) {
  const v=JSON.parse(output);
  assert.equal(typeof v.answer,"string");
  assert.ok(v.answer.trim(),"empty Supervisor answer");
  assert.ok(["complete","partial","missing","estimate"].includes(v.status),"invalid status");
  assert.ok(Array.isArray(v.results),"missing tool results");
  assert.ok(Array.isArray(v.usedTools),"missing tool audit");
  assert.ok(Array.isArray(v.unverified),"missing numeric check");
  assert.ok(Number.isInteger(v.usage.modelCalls)&&v.usage.modelCalls>0,"agent loop was not called");
  return v;
}
function check(action) {
  try { action(); return true; }
  catch(error){
    // Only synthetic fixture values appear in this diagnostic.
    console.error("Supervisor assertion failed: "+error.message);
    return false;
  }
}
/** Cross-check every number flagged by the runtime provenance scanner with
 * the independently verified SQL oracle; never treat a correct value as fake.
 * Any extra unknown numeric claim still fails. */
function verifiedClaims(reply,wanted,unit,tolerance){
  for(const claim of reply.unverified){
    // The runtime scanner sometimes marks the year in a covered period as
    // a free-standing number; check that year against the actual tool period.
    if(claim.kind==="number"&&/^\d{4}$/.test(claim.text)&&
      reply.results.some(r=>r.period?.from?.startsWith(claim.text+"-")&&
        r.period?.to?.startsWith(claim.text+"-")))continue;
    const numeric=Number.parseFloat(claim.text.replaceAll(",",""));
    assert.ok(Number.isFinite(numeric),"unreadable unverified number: "+claim.text);
    const value=claim.kind==="percent"?numeric/100:
      unit==="cents"?numeric*100:numeric;
    assert.ok(Math.abs(value-wanted)<=tolerance,
      "unsupported number differs from SQL truth: "+claim.text);
  }
}
function pathAt(value,path){
  return path.split(".").reduce((obj,key)=>obj?.[key],value);
}
function numbersIn(answer,unit){
  const normalized=answer.replaceAll(",","");
  if(unit==="percent")return [...normalized.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)]
    .map(m=>Number(m[1])/100);
  // Both the currency symbol and a currency code are acceptable; amounts in
  // cents are also accepted if the text explicitly labels the unit.
  if(unit==="cents"){
    const money=[...normalized.matchAll(/(?:[$€£]|(?:[A-Z]{3}\s*))\s*(-?\d+(?:\.\d+)?)/g)]
      .map(m=>Math.round(Number(m[1])*100));
    const pennies=[...normalized.matchAll(/(-?\d+)\s*cents?\b/gi)].map(m=>Number(m[1]));
    return [...money,...pennies];
  }
  return [...normalized.matchAll(/(?<!\d)(-?\d+(?:\.\d+)?)(?!\d)/g)]
    .map(m=>Number(m[1]));
}
/** Explicit owner-facing dates must be the observed business period, not
 * an invented day, even when the corresponding amount happens to be correct. */
function assertDates(reply,context){
  const replay=replays[String(context?.vars?.caseId??"")];
  assert.ok(replay,"unknown recorded case");
  const expected=replay.tools.map(c=>c.args?.period)
    .find(p=>p&&typeof p.from==="string"&&typeof p.to==="string");
  if(!expected)return;
  assert.ok(reply.results.some(r=>r.period?.from===expected.from&&
    r.period?.to===expected.to),"tool read a different business date");
  const months=["January","February","March","April","May","June",
    "July","August","September","October","November","December"];
  const pattern=/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s*[–-]\s*(\d{1,2}))?,?\s+(\d{4})\b/gi;
  const observed=[];
  for(const match of reply.answer.matchAll(pattern)){
    const month=months.findIndex(m=>m.toLowerCase()===match[1].toLowerCase())+1;
    const year=match[4];
    for(const day of [match[2],...(match[3]?[match[3]]:[])]){
      const date=year+"-"+String(month).padStart(2,"0")+"-"+
        String(Number(day)).padStart(2,"0");
      assert.ok(date>=expected.from&&date<=expected.to,"invented answer date: "+date);
      observed.push(date);
    }
  }
  assert.ok(observed.includes(expected.from),"answer omits requested start date");
  assert.ok(observed.includes(expected.to),"answer omits requested end date");
}
module.exports.shape=(output,context)=>check(()=>{
  assertDates(decoded(output),context);
});
module.exports.metric=(output,context)=>check(()=>{
  const reply=decoded(output),cfg=context.vars.check;
  assert.ok(cfg&&typeof cfg==="object","missing case oracle");
  const wanted=seed.sqlTruth[cfg.truth];
  assert.equal(typeof wanted,"number","missing SQL numeric truth");
  const results=reply.results.filter(result=>result.source===cfg.source);
  assert.ok(results.length>0,"Supervisor did not call "+cfg.source);
  const observed=pathAt(results.at(-1),cfg.field);
  assert.equal(typeof observed,"number",cfg.field+" is not a numeric tool result");
  const tolerance=cfg.tolerance??(cfg.unit==="percent"?0.0001:1);
  assert.ok(Math.abs(observed-wanted)<=tolerance,
    "tool result "+observed+" differs from SQL truth "+wanted);
  assert.ok(numbersIn(reply.answer,cfg.unit).some(n=>Math.abs(n-wanted)<=tolerance),
    "Supervisor answer does not state the SQL truth "+wanted);
  verifiedClaims(reply,wanted,cfg.unit,tolerance);
});
module.exports.name=(output,context)=>check(()=>{
  const reply=decoded(output),cfg=context.vars.check;
  const wanted=seed.sqlTruth[cfg.truth];
  assert.equal(typeof wanted,"string","missing SQL identity truth");
  assert.ok(reply.results.some(r=>r.source===cfg.source),"expected read missing");
  assert.ok(reply.answer.toLowerCase().includes(wanted.toLowerCase()),
    "Supervisor failed to identify "+wanted);
  assert.deepEqual(reply.unverified,[],"answer contains unsupported numbers");
});
module.exports.margin=(output)=>check(()=>{
  const reply=decoded(output);
  const rows=reply.results.filter(r=>r.source==="product_costs"&&r.item)
    .map(r=>r.item);
  const menu=seed.menu;
  assert.ok(rows.length>=menu.length,"margin comparison skipped item cost reads");
  for(const item of menu){
    const read=rows.find(row=>row.id===item.id);
    assert.ok(read&&read.recipeCostCents===item.recipeCostCents&&
      read.priceCents===item.priceCents,"mismatched canonical product economics");
  }
  const winner=[...rows].sort((a,b)=>
    (b.priceCents-b.recipeCostCents)-(a.priceCents-a.recipeCostCents))[0];
  assert.equal(winner.name,seed.sqlTruth.highestUnitMarginName,"wrong margin winner");
  assert.equal(winner.priceCents-winner.recipeCostCents,
    seed.sqlTruth.highestUnitMarginCents,"wrong margin amount");
  assert.ok(reply.answer.includes(winner.name),"winner absent from answer");
  const calc=reply.results.find(r=>r.source==="calculate");
  assert.ok(reply.usedTools.includes("calculate"),"derived margin bypassed canonical calculator");
  assert.equal(calc?.result?.valueCents,seed.sqlTruth.highestUnitMarginCents,
    "calculator margin differs from SQL truth");
  assert.ok(numbersIn(reply.answer,"cents").includes(seed.sqlTruth.highestUnitMarginCents),
    "Supervisor did not state the calculated margin");
  assert.deepEqual(reply.unverified,[],"calculated margin must be verified by the real guard");
});
module.exports.missing=(output)=>check(()=>{
  const reply=decoded(output);
  const labor=reply.results.find(r=>r.source==="labor_and_attendance");
  assert.ok(labor,"labor reader wasn't used");
  assert.equal(labor.laborCostPercent,seed.sqlTruth.day21LaborRate);
  assert.ok(labor.missing.some(s=>s.startsWith("laborWageUnknown:")),
    "missing wage was hidden");
  assert.match(reply.answer,/missing|unknown|not recorded|not available|incomplete|cannot verify|don't have/i,
    "owner was not told what is unknown");
  assert.doesNotMatch(reply.answer,/\b0(?:\.0+)?\s*%/,"missing labor became zero");
});
module.exports.inventory=(output)=>check(()=>{
  const reply=decoded(output);
  assert.ok(reply.results.some(r=>r.source==="inventory"&&
    r.missing.includes("inventoryNotTracked")),"inventory status not read");
  assert.match(reply.answer,/not tracked|don't track|not recorded|unknown|unavailable/i);
});
