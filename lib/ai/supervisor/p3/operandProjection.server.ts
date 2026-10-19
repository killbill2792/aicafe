import "server-only";
import { outputFor } from "@/lib/metrics/p1Readers.server";
import { metricUnits,purposePolicies,readers,sourcePolicies,
  values,type SupportedId } from "@/lib/metrics/p1Catalog";
import type { ShadowEvidence } from "@/lib/ai/supervisor/p2/shadow.server";
import type { Operand,Binding } from "./expression";
import { isWholeNamedEntity } from "./entityMatch";
import { fingerprintP1Observation } from "@/lib/metrics/p1ReadFingerprint";
import type { AtomicP1SourceSnapshot } from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import { extractAtomicSnapshot } from "./snapshotOperandSources";

export type OperandChoice={handle:string;entityId:string;entityName:string;
  field:string;matchedClause:string};
export type SourceProjection={operands:Operand[];bindings:Binding[];
  choices:OperandChoice[];missing:string[]};
type Extracted={key:string;name:string;field:string;value:number;
  unit:Operand["unit"]};
type Extractor=(data:unknown)=>Extracted[];
const isObject=(v:unknown):v is Record<string,unknown>=>
  v!==null&&typeof v==="object"&&!Array.isArray(v);
const integer=(n:unknown):n is number=>Number.isSafeInteger(n)&&
  typeof n==="number"&&Math.abs(n)<=1_000_000_000_000;
const text=(v:unknown)=>typeof v==="string"?v:"";
function rows(v:unknown):Record<string,unknown>[] {
  return Array.isArray(v)?v.filter(isObject):[];
}
/** Aggregate only schema-validated daily rows with unique dates. These are
 * observed-row sums, never a claim that every day in a requested period exists.
 * The P1 coverage/quality and the missing source revision remain partial.
 * No model-authored field path, SQL or aggregation expression is accepted.
 */
function dailySums(value:unknown,fields:readonly {
  field:string;unit:Operand["unit"];
}[]):Extracted[]{
  if(!Array.isArray(value)||value.length===0||value.length>366)return [];
  const seen=new Set<string>(),totals=new Map<string,number>();
  for(const field of fields)totals.set(field.field,0);
  for(const row of value){
    if(!isObject(row)||typeof row.date!=="string"||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date)||seen.has(row.date))return [];
    seen.add(row.date);
    for(const field of fields){
      const amount=row[field.field];
      if(!integer(amount))return [];
      const sum=totals.get(field.field)!+amount;
      if(!integer(sum))return [];
      totals.set(field.field,sum);
    }
  }
  return fields.map(field=>({key:"aggregate",name:"daily rows",
    field:field.field,value:totals.get(field.field)!,unit:field.unit}));
}
/** Domain-owned allowlisted value/units, not model-requested arbitrary object paths. */
export const extractors:Partial<Record<SupportedId,Extractor>>={
  // These structured totals already contain the same monetary facts exposed
  // through older scalar P1 aliases. Extract them once from the validated
  // observation; never ask the model to run the same reader a second time.
  "money.monthly_bills":v=>isObject(v)&&integer(v.totalCents)?
    [{key:"value",name:"monthly recurring bills",field:"totalCents",
      value:v.totalCents,unit:"USD_cents" as const}]:[],
  "money.recorded_spending":v=>isObject(v)&&integer(v.totalCents)?
    [{key:"aggregate",name:"recorded spending",field:"totalCents",
      value:v.totalCents,unit:"USD_cents" as const}]:[],
  "money.profitability":v=>isObject(v)?
    (["netSalesCents","totalCostsCents","ownerProfitCents"] as const).flatMap(field=>
      integer(v[field])?[{key:"aggregate",name:"financial performance",
        field,value:v[field] as number,unit:"USD_cents" as const}]:[]):[],

  "menu.catalog":v=>rows(v).flatMap(row=>
    row.active===true&&row.priceStatus==="recorded"&&integer(row.priceCents)?
      [{key:text(row.id),name:text(row.name),field:"priceCents",
        value:row.priceCents,unit:"USD_cents_per_item" as const}]:[]),
  // Read from the canonical business setting, never an invented 12% default.
  // P1 preserves confirmed vs estimated provenance; the calculation remains
  // partial until its source revision and coverage are independently proven.
  "labor.payroll_burden":v=>isObject(v)&&
    integer(v.rateBasisPoints)&&v.rateBasisPoints>=0&&v.rateBasisPoints<=10_000?
      [{key:"aggregate",name:"employer cost rate",field:"rateBasisPoints",
        value:v.rateBasisPoints,unit:"ratio_bps" as const}]:[],
  "labor.employee_wages":v=>rows(v).flatMap(row=>
    row.active===true&&row.wageKnown===true&&row.wagePeriod==="hour"&&
    integer(row.defaultHourlyWageCents)&&row.defaultHourlyWageCents>0?
      [{key:text(row.id),name:text(row.name),field:"defaultHourlyWageCents",
        value:row.defaultHourlyWageCents,unit:"USD_cents_per_hour" as const}]:[]),
  // Domain-owned projections are registered against existing canonical
  // schemas. They generalize across questions; no owner-phrase routing exists.
  "sales.item_units":v=>rows(v).flatMap(row=>
    integer(row.units)&&row.units>=0&&text(row.id)&&text(row.name)?
      [{key:text(row.id),name:text(row.name),field:"units",
        value:row.units,unit:"item" as const}]:[]),
  "sales.daily":v=>dailySums(v,[
    {field:"netSalesCents",unit:"USD_cents"},
    {field:"ingredientsCents",unit:"USD_cents"},
    {field:"cardFeesCents",unit:"USD_cents"},
  ]),
  "labor.daily_costs":v=>dailySums(v,[
    {field:"wagesCents",unit:"USD_cents"},
    {field:"staffTaxCents",unit:"USD_cents"},
    {field:"loadedStaffCostCents",unit:"USD_cents"},
  ]),
  "money.business_costs":v=>{
    if(!isObject(v)||!integer(v.knownTotalCents)||!isObject(v.components)||
      !isObject(v.observed)||!isObject(v.coverage))return [];
    const components=v.components,observed=v.observed,coverage=v.coverage;
    const periodSales=integer(coverage.salesDays)&&integer(coverage.expectedDays)&&
      coverage.salesDays===coverage.expectedDays;
    const periodLabor=integer(coverage.laborDays)&&integer(coverage.expectedDays)&&
      coverage.laborDays===coverage.expectedDays;
    const provenIngredients=periodSales&&observed.ingredients===true&&
      coverage.itemSalesCovered===true&&coverage.historicalIngredientCostsProven===true&&
      coverage.missingProductCostCount===0;
    const provenFees=periodSales&&observed.cardFees===true&&
      coverage.missingFeeDays===0;
    const provenLabor=periodLabor&&observed.loadedStaff===true;
    const provenRunning=observed.runningCosts===true&&
      Array.isArray(coverage.missingOperatingCategories)&&
      coverage.missingOperatingCategories.length===0&&
      Array.isArray(v.missingInputs)&&
      !v.missingInputs.includes("priorMonthRunningCostCoverage");
    // The Money domain records unknown components as numeric zero plus
    // explicit coverage indicators. Never expose those zeros as known costs.
    const provenFields=[
      ["ingredientsCents",provenIngredients],
      ["loadedStaffCents",provenLabor],
      ["cardFeesCents",provenFees],
      ["runningCostsCents",provenRunning],
    ] as const;
    const projected:Extracted[]=[];
    for(const [field,proven] of provenFields){
      if(proven&&integer(components[field]))
        projected.push({key:"aggregate",name:"covered cost component",
          field,value:components[field],unit:"USD_cents"});
    }
    // The total is a true total only after every source component is covered.
    if(v.completeness==="complete"&&provenFields.every(([,ok])=>ok))
      projected.unshift({key:"aggregate",name:"complete business costs",
        field:"knownTotalCents",value:v.knownTotalCents,unit:"USD_cents"});
    return projected;
  },
  "menu.product_economics":v=>{
    if(!isObject(v))return [];
    const out:Extracted[]=[];
    if(integer(v.priceCents))
      out.push({key:text(v.id),name:text(v.name),field:"priceCents",
        value:v.priceCents,unit:"USD_cents_per_item"});
    if(v.costStatus==="READY"&&integer(v.ingredientsCentsToday))
      out.push({key:text(v.id),name:text(v.name),field:"ingredientsCentsToday",
        value:v.ingredientsCentsToday,unit:"USD_cents_per_item"});
    return out;
  },
  // A pricing recommendation lacks a returned, name-bound product identity.
  // It is available as a read, but not composable until resolved against a
  // canonical named menu record. Do not attach an unknown product's price.
  "supplies.quotes":v=>{
    if(!isObject(v))return [];
    return rows(v.items).flatMap(row=>{
      if(row.packageUnit!=="gal"||!integer(row.priceCents)||
        !integer(row.packageCount)||row.packageCount<=0||
        row.priceCents%row.packageCount!==0)return [];
      return [{key:text(row.id),name:text(row.itemName),field:"pricePerGallon",
        value:row.priceCents/row.packageCount,
        unit:"USD_cents_per_US_gallon" as const}];
    });
  },
};
/** Exact recognized source, purpose and reader binding precede every projection. */
export function projectP1Evidence(
  evidence:readonly ShadowEvidence[],businessId:string,ownerGoal:string,
  locationId:string|null=null,ownerHistory:readonly string[]=[],
  atomicSnapshot?:AtomicP1SourceSnapshot,
  entityPolicy:"owner_named"|"authorized_selection"="owner_named",
  maxOperands=12,
):SourceProjection{
  const operands:Operand[]=[],bindings:Binding[]=[],missing:string[]=[];
  const choices:OperandChoice[]=[];
  // Distinct canonical reads of the same handle can race with an owner/POS update.
  // Without revision-backed snapshots, conflicting values must be discarded,
  // not silently assigned to every clause from the first matching read.
  const conflictingHandles=new Set<string>();
  const readSignatures=new Map<string,string>();
  const currentGoal=ownerGoal;
  // A revision is trusted ONLY alongside the same owner-scoped SQL snapshot.
  // Never label independently obtained shadow reads with that revision.
  if(atomicSnapshot && (atomicSnapshot.businessId!==businessId||
    atomicSnapshot.currency!=="USD"))
    return {operands:[],bindings:[],choices:[],missing:["snapshot_scope_conflict"]};
  for(const item of evidence){
    const capability=item.capabilityId;
    if(!capability?.startsWith("p3.")||!capability.endsWith(".v1")||
      !item.result||typeof item.result!=="object")continue;
    const key=capability.slice(3,-3) as SupportedId;
    if(!(key in values))continue;
    const parsed=outputFor(key).safeParse(item.result);
    if(!parsed.success||parsed.data.status==="unavailable")continue;
    // Compare the entire validated envelope, not merely the number: a
    // changed query, quality, coverage or provenance is a different snapshot.
    const independentSignature=JSON.stringify(parsed.data);
    const result=parsed.data as {
      status:"verified"|"estimated"|"partial";value:unknown;unit:string;
      actuality:string;quality:{missingInputs:string[];estimatedInputs:string[];staleInputs:string[]};
      provenance:{canonicalReaderId:string;readerContractVersion:1;
        selectorContractId:string;selectorContractVersion:1;purpose:string;
        sourceRevision:null;asOf:string;timezone:string};
      query:{period?:{from:string;to:string}};
    };
    const provenance=result.provenance;
    const observedContentHash=fingerprintP1Observation({
      businessId,asOf:provenance.asOf,timezone:provenance.timezone,
      readerId:readers[key],selectorId:provenance.selectorContractId,
      selectorVersion:provenance.selectorContractVersion,
      purpose:provenance.purpose,query:result.query,
      value:result.value,quality:result.quality,
    });
    const source=sourcePolicies[key]?.[provenance.purpose];
    if(!source||source.canonicalReaderId!==readers[key]||
      provenance.canonicalReaderId!==readers[key]||
      source.selectorContractId!==provenance.selectorContractId||
      source.selectorContractVersion!==provenance.selectorContractVersion||
      !purposePolicies[key].includes(provenance.purpose as never))continue;
    // The atomic branch uses the earlier authorized read ONLY as a typed
    // selector/purpose. No independent number, status or content hash enters
    // the final calculation. Unsupported atomic domains expose NO operands.
    if(atomicSnapshot && provenance.timezone!==atomicSnapshot.timezone)continue;
    const snapshotValue=atomicSnapshot?extractAtomicSnapshot(key,atomicSnapshot,
      result.query,provenance.asOf):null;
    if(atomicSnapshot && !snapshotValue){
      missing.push("not_projectable_from_atomic_snapshot:"+key);
      continue;
    }
    const unit=metricUnits[key as keyof typeof metricUnits];
    const valuesForKey:Extracted[]=atomicSnapshot?
      (snapshotValue?.leaves??[]):
      unit==="USD_cents" && integer(result.value)?
        [{key:"value",name:key,field:"value",value:result.value,unit:"USD_cents"}]:
      extractors[key]?.(result.value)??[];
    const readSignature=atomicSnapshot?
      JSON.stringify({revision:atomicSnapshot.revision,key,query:result.query,
        leaves:valuesForKey,missing:snapshotValue?.missingInputs,
        stale:snapshotValue?.staleInputs}):independentSignature;
    if(!bindings.some(b=>b.capabilityId===capability))
      bindings.push({capabilityId:capability,
        canonicalReaderId:readers[key],sourceIds:[key],
        purposes:[...purposePolicies[key]],sensitivity:key.startsWith("labor.")?"staff":
          key.startsWith("money.")||key.startsWith("sales.")?"financial":"normal"});
    const named=valuesForKey.map(v=>({id:v.key,name:v.name}));
    const plural=key.startsWith("menu.")||key==="supplies.quotes"||
      key==="sales.item_units";
    // Each read result is scoped to its OWN audited semantic clause. Looking
    // for names across the entire turn could attach another worker's wage to
    // this clause, even with an authentic and correct P1 source record.
    const namedCurrent=new Set(named.filter(v=>
      isWholeNamedEntity(item.clause,v.name,named,plural)).map(v=>v.id));
    const namedElsewhere=new Set(named.filter(v=>
      isWholeNamedEntity(currentGoal,v.name,named,plural)).map(v=>v.id));
    const previousOwnerWords=ownerHistory.slice(-3).join(" ");
    const namedHistory=new Set(named.filter(v=>
      isWholeNamedEntity(previousOwnerWords,v.name,named,plural)).map(v=>v.id));
    const uniqueHistorical=namedCurrent.size===0&&namedElsewhere.size===0&&
      namedHistory.size===1;
    for(const leaf of valuesForKey){
      // Names in record-valued sources must be anchored in the owner's question;
      // otherwise a model could select another employee or product by mistake.
      if(entityPolicy==="owner_named"&&leaf.field!=="value"&&leaf.key!=="aggregate"&&
        !namedCurrent.has(leaf.key)&&
        !(uniqueHistorical&&namedHistory.has(leaf.key)))
        continue;
      // Period-bounded P1 reads are distinct canonical source selections. Two
      // clauses for different date windows must NEVER reuse a first clause's
      // value just because the domain, entity and field names are identical.
      const p=result.query.period;
      // The structured and scalar monthly-bills IDs are two projections of
      // ONE underlying reader. They must never become two arithmetic inputs
      // just because the P3 compatibility runner can still discover both.
      const sameMonthlyFact=key==="money.monthly_bills"||
        key==="money.recurring_monthly_bills_cents";
      const canonicalKey=sameMonthlyFact?"money.monthly_bills":key;
      const canonicalField=sameMonthlyFact?"totalCents":leaf.field;
      const handle=canonicalKey+":"+leaf.key+":"+canonicalField+
        (p?":"+p.from+":"+p.to:"");
      // Equal source epochs/values deduplicate, but differing values, dates
      // or quality still conflict and remove the operand fail-closed.
      const signature=sameMonthlyFact?JSON.stringify({
        reader:"getMonthlyBills",revision:atomicSnapshot?.revision??null,
        asOf:provenance.asOf,period:p??null,value:leaf.value,
        quality:result.quality,missing:snapshotValue?.missingInputs??[],
        stale:snapshotValue?.staleInputs??[],
      }):readSignature;
      if(handle.length>120)continue;
      // Same registered handle can legitimately be mentioned by several
      // clauses. Keep one trusted numeric operand but preserve EVERY clause
      // association so a plan cannot borrow it from an unrelated clause.
      const choice={handle,entityId:leaf.key,entityName:leaf.name,
        field:leaf.field,matchedClause:item.clause};
      const previous=operands.find(o=>o.handle===handle);
      if(previous){
        if(readSignatures.get(handle)!==signature){
          conflictingHandles.add(handle);
          missing.push("conflicting_source_snapshot:"+key);
          continue;
        }
        if(!choices.some(c=>c.handle===handle&&c.matchedClause===item.clause))
          choices.push(choice);
        continue;
      }
      // Keep reviewing repeated handles even after reaching the twelve-leaf
      // exposure limit; otherwise a late conflicting read could go undetected.
      if(operands.length>=Math.min(120,Math.max(0,maxOperands)))continue;
      readSignatures.set(handle,signature);
      // Keep the server-resolved name, ID, field and originating clause
      // alongside the opaque handle. The model must never infer UUID identities.
      choices.push(choice);
      operands.push({
        handle,capabilityId:capability,canonicalReaderId:readers[key],
        sourceId:key,sourcePurpose:provenance.purpose,
        sourceRevision:atomicSnapshot?.revision??null,
        observedContentHash:atomicSnapshot?null:observedContentHash,
        selectorContractId:provenance.selectorContractId,selectorContractVersion:1,
        businessId,locationId,asOf:provenance.asOf,
        period:p?{from:p.from,to:p.to,timezone:provenance.timezone}:null,
        status:"partial",actuality:result.actuality==="actual"?"actual":
          result.actuality==="planned"?"planned":"estimated",
        evidenceStatus:"unverified",
        missingInputs:atomicSnapshot?
          [...new Set(["coverage_not_proven_by_revision",
            ...(snapshotValue?.missingInputs??[])])].slice(0,20):
          [...result.quality.missingInputs,"unversioned_source"].slice(0,20),
        staleInputs:(atomicSnapshot?snapshotValue?.staleInputs:
          result.quality.staleInputs)?.slice(0,20)??[],unit:leaf.unit,
        currency:"USD",value:leaf.value,
      });
    }
    if(!valuesForKey.length)missing.push("unprojectable:"+key);
  }
  // A later matching read cannot reinstate a handle already found inconsistent.
  return {operands:operands.filter(o=>!conflictingHandles.has(o.handle)),
    bindings,choices:choices.filter(c=>!conflictingHandles.has(c.handle)),missing};
}
