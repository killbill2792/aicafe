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
  return [
    {id:metric+":"+identity+":recorded:"+recordedCents,label:labels.recordedChoice+" "+money(recordedCents),detail},
    {id:metric+":"+identity+":owner:"+ownerCents,label:labels.ownerChoice+" "+money(ownerCents),detail},
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
