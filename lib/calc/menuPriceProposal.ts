/** Business arithmetic for menu-price cards and observed post-change sales.
 * Values remain integer cents; incomplete observations are not zero days. */
export function menuPriceDelta(oldPriceCents:number,newPriceCents:number){
  if(!Number.isSafeInteger(oldPriceCents)||!Number.isSafeInteger(newPriceCents))
    throw new Error("Invalid integer prices");
  return {deltaCents:newPriceCents-oldPriceCents,increased:newPriceCents>oldPriceCents};
}
export function priceInputCents(raw:string):number|null{
  if(!/^\d+(?:\.\d{1,2})?$/.test(raw))return null;
  const amount=Math.round(Number(raw)*100);
  return Number.isSafeInteger(amount)&&amount>=1&&amount<=100000?amount:null;
}
export function priceEditString(cents:number){return (cents/100).toFixed(2);}

export type MenuSaleObservation={
  businessDate:string;observation:Record<string,unknown>;
};
export function summarizeActualMenuSales(samples:readonly MenuSaleObservation[]){
  const days=new Map<string,{units:number;netSalesCents:number}>();
  for(const sample of samples){
    const o=sample.observation;
    if(o.coverage!=="actual"||
      !Number.isSafeInteger(o.units)||Number(o.units)<0||
      !Number.isSafeInteger(o.netSalesCents)||Number(o.netSalesCents)<0)continue;
    days.set(sample.businessDate,{units:Number(o.units),netSalesCents:Number(o.netSalesCents)});
  }
  const coveredDays=days.size;
  return {coveredDays,observedUnits:coveredDays?
    [...days.values()].reduce((sum,s)=>sum+s.units,0):null,
    observedRevenueCents:coveredDays?
    [...days.values()].reduce((sum,s)=>sum+s.netSalesCents,0):null};
}
