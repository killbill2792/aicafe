import {hasCoveredSales} from "./salesCoverage";
/** One known-component profit subtotal, with structured notes for unknown parts. */
export type ProfitSalesDay={date:string;netSalesCents:number;salesDataStatus?:"actual"|"missing"};
export type ProfitPart={amountCents:number|null;missing?:readonly string[];estimated?:boolean};
export type ProfitResult={
  profitCents:number|null;netSalesCents:number;
  partsUsed:{billsCents:number;feesCents:number;laborCents:number;productCostsCents:number};
  coveredSalesDays:number;expectedSalesDays:number;notes:string[];
  basis:"complete"|"partial"|"estimated"|"unavailable";
};
export function profitForPeriod(days:readonly ProfitSalesDay[],bills:ProfitPart,fees:ProfitPart,
  labor:ProfitPart,productCosts:ProfitPart):ProfitResult{
  const observed=days.filter(hasCoveredSales);
  const netSalesCents=observed.reduce((sum,d)=>sum+d.netSalesCents,0);
  const partsUsed={
    billsCents:bills.amountCents??0,feesCents:fees.amountCents??0,
    laborCents:labor.amountCents??0,productCostsCents:productCosts.amountCents??0,
  };
  const notes:string[]=[];
  if(observed.length<days.length)notes.push("profitSalesDaysMissing");
  const parts=[["Bills",bills],["Fees",fees],["Labor",labor],["ProductCosts",productCosts]] as const;
  for(const [name,part] of parts){
    if(part.amountCents===null||(part.missing?.length??0)>0)notes.push("profit"+name+"Missing");
    if(part.estimated)notes.push("profit"+name+"Estimated");
  }
  const available=observed.length>0;
  const incomplete=notes.some(n=>n.endsWith("Missing"));
  const basis=!available?"unavailable":incomplete?"partial":
    notes.some(n=>n.endsWith("Estimated"))?"estimated":"complete";
  return {profitCents:available?Math.round(netSalesCents-Object.values(partsUsed).reduce((a,b)=>a+b,0)):null,
    netSalesCents,partsUsed,coveredSalesDays:new Set(observed.map(d=>d.date)).size,
    expectedSalesDays:new Set(days.map(d=>d.date)).size,notes,basis};
}
