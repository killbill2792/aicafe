import {catalogForMissing} from "./catalog";
import type {SavedFact} from "./inject";
export type SavedFactCurrent={value:string;savedOn:string;canForget:boolean};
/** The longest answer a card accepts (the owner-answer route's limit). */
export const OWNER_ANSWER_MAX=1000;
/** What a change card shows for one saved fact: the value as the owner would type it,
 * the day it was saved, and whether it can be forgotten here. Facts that were also
 * copied to a screen (bills, card fees, payroll extras) are changed, not forgotten,
 * so the chat and the screens never disagree. */
export function savedFactCurrent(facts:readonly SavedFact[],key:string,inputType:string):SavedFactCurrent|null{
 const fact=facts.find(f=>f.fact_key===key);
 if(!fact)return null;
 const v=fact.value_json;
 let value:string;
 if(inputType==="money"){
  if(typeof v!=="number"||!Number.isSafeInteger(v))return null;
  value=(v/100).toFixed(2);
 }else if(typeof v==="number"||typeof v==="string"||typeof v==="boolean")value=String(v);
 else return null;
 // The card edits the whole value; never a shortened copy that a save would keep.
 if(value.length>OWNER_ANSWER_MAX)return null;
 return {value,savedOn:fact.created_at.slice(0,10),
  canForget:catalogForMissing(key).target==="owner_facts"};
}

type CardField={key:string;remember?:"this_question";current?:SavedFactCurrent};
type Answer={fieldKey:string;value:string;forget?:boolean};
/** Splits a card's answers into facts to save and saved facts to forget.
 * Throws on a forget the card does not offer, or an answer to an unknown field. */
export function splitOwnerAnswers(card:{changeSaved?:true;fields:readonly CardField[]},
 answers:readonly Answer[]):{keep:Answer[];forget:string[];usedOnce:number}{
 const keep:Answer[]=[],forget:string[]=[];let usedOnce=0;
 if(!answers.length||new Set(answers.map(a=>a.fieldKey)).size!==answers.length)throw new Error("invalid_owner_answers");
 for(const answer of answers){
  const field=card.fields.find(f=>f.key===answer.fieldKey);
  if(!field)throw new Error("invalid_owner_answers");
  if(answer.forget===true){
   if(card.changeSaved!==true||!field.current?.canForget)throw new Error("forget_not_offered");
   forget.push(field.key);
  }else if(field.remember==="this_question")usedOnce++;
  else keep.push({fieldKey:answer.fieldKey,value:answer.value});
 }
 return {keep,forget,usedOnce};
}
