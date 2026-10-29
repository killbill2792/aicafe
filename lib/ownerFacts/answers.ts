import {catalogForMissing} from "./catalog";
import type {OwnerFactAnswer} from "./store.server";
import {parseOwnerFactDecimal} from "./numbers";
export function validateOwnerAnswers(
 fields:readonly {key:string;inputType:string;units:readonly string[];defaultUnit:string;
  choices?:readonly {label:string;value:string}[]}[],
 answers:readonly {fieldKey:string;value:string}[],locale:"en"|"es"|"ar"
):OwnerFactAnswer[]{
 if(!answers.length||answers.length>fields.length||
    new Set(answers.map(a=>a.fieldKey)).size!==answers.length)
   throw new Error("invalid_owner_answers");
 return answers.map(answer=>{
  const field=fields.find(f=>f.key===answer.fieldKey);
  if(!field)throw new Error("invalid_owner_answers");
  const {value:raw}=answer;
  let value:unknown=raw.trim(),unit:string|null=null;
  if(field.inputType==="money"||field.inputType==="percent"||field.inputType==="number"){
   const parsed=parseOwnerFactDecimal(raw,locale);
   if(parsed===null)throw new Error("invalid_owner_number");
   if(field.inputType==="money"){
    const cents=Math.round(parsed*100);
    if(!Number.isSafeInteger(cents)||cents<0)throw new Error("invalid_owner_number");
    value=cents;unit="cents";
   }else if(field.inputType==="percent"){
    if(parsed>100)throw new Error("invalid_owner_percent");
    value=parsed;unit="percent";
   }else value=parsed;
  }else if(field.inputType==="date"){
   if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)||Number.isNaN(Date.parse(raw+"T12:00:00Z"))||
      new Date(raw+"T12:00:00Z").toISOString().slice(0,10)!==raw)
     throw new Error("invalid_owner_date");
  }else if(field.inputType==="choice"){
   if(!field.choices?.some(choice=>choice.value===raw))throw new Error("invalid_owner_choice");
  }else if(field.inputType==="text"){
   if(!raw.trim()||raw.length>1000)throw new Error("invalid_owner_text");
  }else throw new Error("invalid_owner_field");
  const definition=catalogForMissing(field.key);
  // Do not let a model-generated field secretly write a financial target
  // with a misleading type (for example a text answer into monthly bills).
  if(definition.labelKey!=="generic"&&definition.type!==field.inputType)throw new Error("mismatched_owner_fact_type");
  const factKey=definition.factKey;
  if(!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(factKey))
   throw new Error("invalid_owner_key");
  return {fieldKey:factKey,value,unit,periodScope:field.inputType==="money"&&
   /monthly|payroll|bills/i.test(factKey)?"month":null};
 });
}
