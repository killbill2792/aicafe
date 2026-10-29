import {emptyOwnerInputs,type OwnerInputs} from "@/lib/ai/agent/tools/ownerInputs";
export type SavedFact={fact_key:string;value_json:unknown;created_at:string;unit:string|null;period_scope:string|null};
export function savedValue(facts:readonly SavedFact[],key:string):unknown{
 return facts.find(f=>f.fact_key===key)?.value_json;
}
/** Only existing ownerInputs parameters may be populated; never invent a tool argument.
 * Recorded tool reads remain the authority over owner numbers. */
export function injectSavedOwnerInputs(raw:unknown,facts:readonly SavedFact[],supportsOwnerInputs=false):unknown{
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return raw;
 if(!("ownerInputs" in raw)&&!supportsOwnerInputs)return raw;
 const obj=raw as Record<string,unknown>;
 const original=obj.ownerInputs ?? null;
 if(original!==null&&(!original||typeof original!=="object"||Array.isArray(original)))return raw;
 const existing=(original??{}) as Partial<OwnerInputs>;
 const value=(key:string)=>{const n=savedValue(facts,key);return typeof n==="number"&&Number.isSafeInteger(n)&&n>=0?n:null;};
 const labor=value("monthly_payroll_cents"),rent=value("rent_monthly_cents");
 const itemId=typeof obj.itemId==="string"?obj.itemId:
   typeof obj.item_id==="string"?obj.item_id:null;
 const cost=itemId?value("unit_cost_cents:item:"+itemId):null;
 if(!("ownerInputs" in obj)&&labor===null&&rent===null&&cost===null)return raw;
 const injected:OwnerInputs={...emptyOwnerInputs,...existing};
 if(injected.laborCents==null&&labor!==null){injected.laborCents=labor;injected.laborPeriod={unit:"month"};}
 if(injected.rentCents==null&&rent!==null)injected.rentCents=rent;
 // A saved *total* bill is not the tool's 'other overhead' field.
 // The screen-visible recurring-cost read remains authoritative; SQL writes
 // through only when doing so cannot double-count itemized expenses.
 // Never use the unscoped legacy cost for another item.
 if(injected.unitCostCents==null&&cost!==null)injected.unitCostCents=cost;
 return {...obj,ownerInputs:injected};
}
/** Only current café facts are provided. Do not silently hide older current keys:
 * the ask guard and the model must see the same set of stored answers. */
export function formatSavedOwnerFacts(facts:readonly SavedFact[]):string{
 const safe=facts.filter(f=>/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(f.fact_key))
  .map(f=>f.fact_key+"="+JSON.stringify(f.value_json).slice(0,160)+" ("+f.created_at.slice(0,10)+")");
 return safe.length?"Saved by owner: "+safe.join("; "):"";
}
