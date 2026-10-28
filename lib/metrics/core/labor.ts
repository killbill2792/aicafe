/** Labor cost with explicit coverage: partial wages are never passed off as a complete payroll. */
export type LaborRecord={
  date:string;wagesCents:number|null;staffTaxCents:number|null;
  laborWageStatus?:"actual"|"estimate"|"missing";
  staffTaxStatus?:"actual"|"estimated";
};
export type LaborResult={
  knownLaborCents:number;projectedMonthlyLaborCents:number;
  coveredDays:number;totalDays:number;
  basis:"owner_provided"|"recorded"|"projected"|"partial";
  notes:string[];
};
export function laborForPeriod(days:readonly {date:string}[],wages:readonly LaborRecord[],
  ownerMonthlyPayroll:number|null=null):LaborResult{
  const dates=new Set(days.map(day=>day.date));
  const included=wages.filter(d=>dates.has(d.date));
  const totalDays=dates.size;
  const covered=included.filter(d=>d.wagesCents!==null&&d.staffTaxCents!==null&&d.laborWageStatus!=="missing");
  const knownLaborCents=included.reduce((sum,d)=>sum+(d.wagesCents??0)+(d.staffTaxCents??0),0);
  const coveredDays=new Set(covered.map(d=>d.date)).size;
  const projectedBase=covered.reduce((sum,d)=>sum+d.wagesCents!+d.staffTaxCents!,0);
  const notes:string[]=[];
  if(coveredDays<totalDays)notes.push("laborCoveragePartial");
  if(included.some(d=>d.wagesCents===null||d.staffTaxCents===null||d.laborWageStatus==="missing"))
    notes.push("laborWageUnknown");
  if(included.some(d=>d.laborWageStatus==="estimate"||d.staffTaxStatus==="estimated"))
    notes.push("laborEstimated");
  if(coveredDays===0)notes.push("laborNoCoveredDays");
  if(ownerMonthlyPayroll!==null){
    if(!Number.isSafeInteger(ownerMonthlyPayroll)||ownerMonthlyPayroll<0)
      throw new RangeError("Invalid owner payroll");
    return {knownLaborCents,projectedMonthlyLaborCents:ownerMonthlyPayroll,coveredDays,
      totalDays,basis:"owner_provided",notes};
  }
  return {
    knownLaborCents,projectedMonthlyLaborCents:coveredDays>0?
      Math.round(projectedBase*totalDays/coveredDays):knownLaborCents,
    coveredDays,totalDays,
    basis:coveredDays===0?"partial":coveredDays<totalDays?"projected":"recorded",
    notes,
  };
}
export function laborPercentForPeriod(laborCents:number,netSalesCents:number):number|null{
  return netSalesCents>0?laborCents/netSalesCents:null;
}
