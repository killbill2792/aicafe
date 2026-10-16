import "server-only";
import { outputFor } from "@/lib/metrics/p1Readers.server";
import { metricUnits,purposePolicies,readers,sourcePolicies,
  values,type SupportedId } from "@/lib/metrics/p1Catalog";
import type { ShadowEvidence } from "@/lib/ai/supervisor/p2/shadow.server";
import type { Operand,Binding } from "./expression";
import { isWholeNamedEntity } from "./entityMatch";

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
  "menu.catalog":v=>rows(v).flatMap(row=>
    row.active===true&&row.priceStatus==="recorded"&&integer(row.priceCents)?
      [{key:text(row.id),name:text(row.name),field:"priceCents",
        value:row.priceCents,unit:"USD_cents_per_item" as const}]:[]),
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
):SourceProjection{
  const operands:Operand[]=[],bindings:Binding[]=[],missing:string[]=[];
  const choices:OperandChoice[]=[];
  const currentGoal=ownerGoal;
  for(const item of evidence){
    if(operands.length>=12)break;
    const capability=item.capabilityId;
    if(!capability?.startsWith("p3.")||!capability.endsWith(".v1")||
      !item.result||typeof item.result!=="object")continue;
    const key=capability.slice(3,-3) as SupportedId;
    if(!(key in values))continue;
    const parsed=outputFor(key).safeParse(item.result);
    if(!parsed.success||parsed.data.status==="unavailable")continue;
    const result=parsed.data as {
      status:"verified"|"estimated"|"partial";value:unknown;unit:string;
      actuality:string;quality:{missingInputs:string[];estimatedInputs:string[];staleInputs:string[]};
      provenance:{canonicalReaderId:string;readerContractVersion:1;
        selectorContractId:string;selectorContractVersion:1;purpose:string;
        sourceRevision:null;asOf:string;timezone:string};
      query:{period?:{from:string;to:string}};
    };
    const provenance=result.provenance;
    const source=sourcePolicies[key]?.[provenance.purpose];
    if(!source||source.canonicalReaderId!==readers[key]||
      provenance.canonicalReaderId!==readers[key]||
      source.selectorContractId!==provenance.selectorContractId||
      source.selectorContractVersion!==provenance.selectorContractVersion||
      !purposePolicies[key].includes(provenance.purpose as never))continue;
    const unit=metricUnits[key as keyof typeof metricUnits];
    const valuesForKey:Extracted[]=
      unit==="USD_cents" && integer(result.value)?
        [{key:"value",name:key,field:"value",value:result.value,unit:"USD_cents"}]:
      extractors[key]?.(result.value)??[];
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
      if(operands.length>=12)break;
      // Names in record-valued sources must be anchored in the owner's question;
      // otherwise a model could select another employee or product by mistake.
      if(leaf.field!=="value"&&leaf.key!=="aggregate"&&
        !namedCurrent.has(leaf.key)&&
        !(uniqueHistorical&&namedHistory.has(leaf.key)))
        continue;
      const handle=key+":"+leaf.key+":"+leaf.field;
      // Same registered handle can legitimately be mentioned by several
      // clauses. Keep one trusted numeric operand but preserve EVERY clause
      // association so a plan cannot borrow it from an unrelated clause.
      const choice={handle,entityId:leaf.key,entityName:leaf.name,
        field:leaf.field,matchedClause:item.clause};
      if(operands.some(o=>o.handle===handle)){
        if(!choices.some(c=>c.handle===handle&&c.matchedClause===item.clause))
          choices.push(choice);
        continue;
      }
      const p=result.query.period;
      // Keep the server-resolved name, ID, field and originating clause
      // alongside the opaque handle. The model must never infer UUID identities.
      choices.push(choice);
      operands.push({
        handle,capabilityId:capability,canonicalReaderId:readers[key],
        sourceId:key,sourcePurpose:provenance.purpose,sourceRevision:null,
        selectorContractId:provenance.selectorContractId,selectorContractVersion:1,
        businessId,locationId,asOf:provenance.asOf,
        period:p?{from:p.from,to:p.to,timezone:provenance.timezone}:null,
        status:"partial",actuality:result.actuality==="actual"?"actual":
          result.actuality==="planned"?"planned":"estimated",
        evidenceStatus:"unverified",
        missingInputs:[...result.quality.missingInputs,"unversioned_source"],
        staleInputs:[...result.quality.staleInputs],unit:leaf.unit,
        currency:"USD",value:leaf.value,
      });
    }
    if(!valuesForKey.length)missing.push("unprojectable:"+key);
  }
  return {operands,bindings,choices,missing};
}
