export type ClockedWageEvidence={
 businessDate:string;clockOut:string|null;hourlyWageCents:number|null
};
import {laborKnown} from "./profit";
export type PayrollRollupEvidence={
 businessDate:string;staffWagesCents:number|null;staffTaxCents:number|null;
 laborWageStatus:"actual"|"estimate"|"missing"|null;taxStatus:string|null
};
/** No day is verified when one of its clocked staff has an unknown wage,
 * open timecard, or when the canonical wages/tax row did not persist. */
export function payrollDayCoverage(cards:readonly ClockedWageEvidence[],
 rollups:readonly PayrollRollupEvidence[]){
 const byDay=new Map<string,ClockedWageEvidence[]>();
 for(const card of cards){
  const group=byDay.get(card.businessDate)??[];
  group.push(card);
  byDay.set(card.businessDate,group);
 }
 const rollupByDay=new Map(rollups.map(row=>[row.businessDate,row]));
 const coveredDates=new Set<string>(),taxEstimatedDays=new Set<string>();
 const validCents=(n:number|null)=>n!==null&&Number.isSafeInteger(n)&&n>=0;
 for(const [date,dayCards] of byDay){
  const rollup=rollupByDay.get(date);
  if(!rollup||dayCards.length===0||
    !dayCards.every(row=>typeof row.clockOut==="string"&&validCents(row.hourlyWageCents))||
    !validCents(rollup.staffWagesCents)||!validCents(rollup.staffTaxCents)||
    !laborKnown({wagesCents:rollup.staffWagesCents,staffTaxCents:rollup.staffTaxCents,
      laborWageStatus:rollup.laborWageStatus??"missing"}))continue;
  coveredDates.add(date);
  if(rollup.taxStatus!=="actual")taxEstimatedDays.add(date);
 }
 return {coveredDates,taxEstimatedDays};
}
