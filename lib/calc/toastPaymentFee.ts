/** Pure classification of per-transaction Toast fees. Never turn a missing
 * fee or unconfirmed rate plan into an actual zero-dollar charge. */
export type ToastFeeInput={
 amountCents:number|null;type:string|null;cardType:string|null;
 cardEntryMode:string|null;originalProcessingFeeCents:number|null;
};
export type ToastCardRule={cardType:string;cardEntryMode:string;
 percentageBps:number;fixedFeeCents:number};
export type ToastFeeDecision={amountCents:number|null;
 status:"actual"|"estimated"|"missing";basis:"toast"|"owner_plan"|"cash_or_gift"|"missing"};
export function determineToastPaymentFee(p:ToastFeeInput,rules:readonly ToastCardRule[]):ToastFeeDecision{
 const type=(p.type??"").toUpperCase().replace(/[^A-Z]/g,"");
 if(type==="CASH"||type==="GIFTCARD"||type==="GIFTCERTIFICATE")
  return {amountCents:0,status:"actual",basis:"cash_or_gift"};
 if(p.originalProcessingFeeCents!==null){
  if(!Number.isSafeInteger(p.originalProcessingFeeCents)||p.originalProcessingFeeCents<0)
   return {amountCents:null,status:"missing",basis:"missing"};
  return {amountCents:p.originalProcessingFeeCents,status:"actual",basis:"toast"};
 }
 const matching=rules.filter(r=>r.cardType===p.cardType&&r.cardEntryMode===p.cardEntryMode);
 if(matching.length!==1||p.amountCents===null||!Number.isSafeInteger(p.amountCents)||p.amountCents<0)
  return {amountCents:null,status:"missing",basis:"missing"};
 const r=matching[0];
 if(!Number.isInteger(r.percentageBps)||r.percentageBps<0||r.percentageBps>5000||
  !Number.isInteger(r.fixedFeeCents)||r.fixedFeeCents<0||r.fixedFeeCents>5000)
  return {amountCents:null,status:"missing",basis:"missing"};
 return {amountCents:Math.round(p.amountCents*r.percentageBps/10000)+r.fixedFeeCents,
  status:"estimated",basis:"owner_plan"};
}
