import type {ResolveState,ChoiceCandidate} from "./resolve";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

export type MoneySourceChoice="recorded"|"owner";
type MoneyMetric="sales"|"unitCost";
type Locale="en"|"es"|"ar";

/** Both choices are bound to the currently re-read metric, entity/period and values.
 * They originate in an authenticated business tool result, never model-provided IDs.
 * A stale selection cannot substitute an old amount for newly changed owner data. */
export function moneyChoiceCandidates(metric:MoneyMetric,identity:string,
  recordedCents:number,ownerCents:number,locale:Locale):[ChoiceCandidate,ChoiceCandidate]{
  const labels=({en,es,ar} as const)[locale].AgentFields;
  const money=(cents:number)=>new Intl.NumberFormat(locale,{style:"currency",currency:"USD"}).format(cents/100);
  const detail=metric==="sales"?labels.netSalesCents:labels.totalCostsCents;
  const key=metric+":"+identity.toLowerCase()+":"+recordedCents+":"+ownerCents;
  return [
    {id:key+":recorded",label:labels.recordedChoice+" "+money(recordedCents),detail},
    {id:key+":owner",label:labels.ownerChoice+" "+money(ownerCents),detail},
  ];
}
/** A selection is valid for one follow-up turn only, and only if it matches one
 * freshly generated pair from current owner-provided and recorded values. */
export function chosenMoneySource(state:ResolveState|undefined,
  candidates:readonly ChoiceCandidate[]):MoneySourceChoice|null{
  if(!state?.chosenIds.size||candidates.length!==2)return null;
  const selected=candidates.map((candidate,i)=>state.chosenIds.has(candidate.id.toLowerCase())?i:-1)
    .filter(i=>i>=0);
  return selected.length!==1?null:selected[0]===0?"recorded":"owner";
}

/** On the following turn the model may omit the old owner amount; recover it
 * only from the actual trusted previous clarification and only while the
 * freshly read recorded figure still matches the original snapshot. */
export function replayedMoneyChoice(state:ResolveState|undefined,metric:MoneyMetric,
  identity:string,recordedCents:number):{source:MoneySourceChoice;ownerCents:number}|null{
  if(!state?.chosenIds.size)return null;
  const prefix=(metric+":"+identity.toLowerCase()+":"+recordedCents+":").toLowerCase();
  const matches=[...state.chosenIds].flatMap(id=>{
    if(!id.startsWith(prefix))return [];
    const tail=id.slice(prefix.length);
    const match=/^(\\d+):(recorded|owner)$/u.exec(tail);
    if(!match)return [];
    const ownerCents=Number(match[1]);
    return Number.isSafeInteger(ownerCents)?[{source:match[2] as MoneySourceChoice,ownerCents}]:[];
  });
  return matches.length===1?matches[0]:null;
}
