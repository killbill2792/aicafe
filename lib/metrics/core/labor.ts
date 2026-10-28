/** Labor cost with explicit coverage: partial wages are never passed off as a complete payroll. */
import {shiftCafeDate} from "./clock";
export type OwnerPayrollExtras={monthlyCents:number;from:string;to:string};
export function proratedOwnerPayrollExtrasCents(input:OwnerPayrollExtras):number{
  if(!Number.isSafeInteger(input.monthlyCents)||input.monthlyCents<0||
    input.to<input.from)throw new RangeError("Invalid owner payroll extras");
  let cursor=input.from,amount=0,months=0;
  while(cursor<=input.to){
    const [year,month]=cursor.slice(0,7).split("-").map(Number);
    const end=cursor.slice(0,7)+"-"+String(new Date(Date.UTC(year,month,0)).getUTCDate()).padStart(2,"0");
    const until=end<input.to?end:input.to;
    const fromMs=Date.parse(cursor+"T12:00:00Z"),toMs=Date.parse(until+"T12:00:00Z");
    if(!Number.isFinite(fromMs)||!Number.isFinite(toMs))throw new RangeError("Invalid payroll date");
    amount+=input.monthlyCents*(Math.round((toMs-fromMs)/86400000)+1)/
      new Date(Date.UTC(year,month,0)).getUTCDate();
    cursor=shiftCafeDate(until,1);
    if(++months>120)throw new RangeError("Payroll period too long");
  }
  return Math.round(amount);
}
export type LaborRecord={
  date:string;wagesCents:number|null;staffTaxCents:number|null;
  laborWageStatus?:"actual"|"estimate"|"missing";
  staffTaxStatus?:"actual"|"estimated";
};
export type LaborResult={
  knownLaborCents:number;projectedMonthlyLaborCents:number|null;
  coveredDays:number;totalDays:number;
  basis:"owner_provided"|"recorded"|"projected"|"partial";
  notes:string[];
};
export function laborForPeriod(days:readonly {date:string}[],wages:readonly LaborRecord[],
  ownerMonthlyPayroll:number|null=null,ownerExtras:OwnerPayrollExtras|null=null):LaborResult{
  const dates=new Set(days.map(day=>day.date));
  const included=wages.filter(d=>dates.has(d.date));
  const totalDays=dates.size;
  const covered=included.filter(d=>d.wagesCents!==null&&d.staffTaxCents!==null&&d.laborWageStatus!=="missing");
  const clockedCents=included.reduce((sum,d)=>sum+(d.wagesCents??0)+(d.staffTaxCents??0),0);
  const knownLaborCents=clockedCents+(ownerMonthlyPayroll===null&&ownerExtras?
    proratedOwnerPayrollExtrasCents(ownerExtras):0);
  const coveredDays=new Set(covered.map(d=>d.date)).size;
  const projectedBase=covered.reduce((sum,d)=>sum+d.wagesCents!+d.staffTaxCents!,0);
  const notes:string[]=[];
  if(coveredDays<totalDays)notes.push("laborCoveragePartial");
  if(included.some(d=>d.wagesCents===null||d.staffTaxCents===null||d.laborWageStatus==="missing"))
    notes.push("laborWageUnknown");
  if(included.some(d=>d.laborWageStatus==="estimate"||d.staffTaxStatus==="estimated"))
    notes.push("laborEstimated");
  if(coveredDays===0)notes.push("laborNoCoveredDays");
  if(ownerExtras?.monthlyCents&&ownerMonthlyPayroll===null)notes.push("laborOwnerExtras");
  if(ownerMonthlyPayroll!==null){
    if(!Number.isSafeInteger(ownerMonthlyPayroll)||ownerMonthlyPayroll<0)
      throw new RangeError("Invalid owner payroll");
    return {knownLaborCents,projectedMonthlyLaborCents:ownerMonthlyPayroll,coveredDays,
      totalDays,basis:"owner_provided",notes};
  }
  return {
    knownLaborCents,projectedMonthlyLaborCents:coveredDays>0?
      Math.round(projectedBase*totalDays/coveredDays)+(ownerExtras?.monthlyCents??0):null,
    coveredDays,totalDays,
    basis:coveredDays===0?"partial":coveredDays<totalDays?"projected":"recorded",
    notes,
  };
}
export function laborPercentForPeriod(laborCents:number,netSalesCents:number):number|null{
  return netSalesCents>0?laborCents/netSalesCents:null;
}
