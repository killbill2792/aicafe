import {catalogForMissing} from "./catalog";
import {savedValue,type SavedFact} from "./inject";
/** The model must not re-ask facts already stored for this café, including
 * fields it included alongside genuinely missing ones. Existing choice
 * resolution/approval questions are never silently suppressed. */
export function withoutSavedFactFields(raw:unknown,facts:readonly SavedFact[]):unknown|null{
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return raw;
 const question=raw as Record<string,unknown>;
 if(question.kind!=="facts"||!Array.isArray(question.fields))return raw;
 const fields=question.fields.filter(field=>{
  if(!field||typeof field!=="object"||typeof field.key!=="string")return true;
  const key=catalogForMissing(field.key).factKey;
  return savedValue(facts,key)===undefined;
 });
 return fields.length?{...question,fields}:null;
}
