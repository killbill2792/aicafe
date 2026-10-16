import "server-only";
import { outputFor } from "@/lib/metrics/p1Readers.server";
import { metricUnits,purposePolicies,readers,sourcePolicies,
  values,type SupportedId } from "@/lib/metrics/p1Catalog";
import type { ShadowEvidence } from "@/lib/ai/supervisor/p2/shadow.server";
import type { Operand,Binding } from "./expression";

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
  locationId:string|null=null,
):SourceProjection{
  const operands:Operand[]=[],bindings:Binding[]=[],missing:string[]=[];
  const choices:OperandChoice[]=[];
  const normalized=ownerGoal.normalize("NFKC").toLocaleLowerCase();
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
    for(const leaf of valuesForKey){
      if(operands.length>=12)break;
      // Names in record-valued sources must be anchored in the owner's question;
      // otherwise a model could select another employee or product by mistake.
      if(leaf.field!=="value"&&
        (!leaf.name||!normalized.includes(leaf.name.normalize("NFKC").toLocaleLowerCase())))
        continue;
      const handle=key+":"+leaf.key+":"+leaf.field;
      if(operands.some(o=>o.handle===handle))continue;
      const p=result.query.period;
      // Keep the server-resolved name, ID, field and originating clause
      // alongside the opaque handle. The model must never infer UUID identities.
      choices.push({handle,entityId:leaf.key,entityName:leaf.name,
        field:leaf.field,matchedClause:item.clause});
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
