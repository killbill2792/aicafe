import {z} from "zod";
import {calendarMonth,prorate,dateOffset,type CalcPeriod} from "@/lib/calc/periods";
const cents=z.number().int().safe().nonnegative();
const period=z.union([
 z.strictObject({from:z.iso.date(),to:z.iso.date()}),
 z.strictObject({days:z.number().int().positive().max(3660)}),
]);
export const ownerInputsSchema=z.strictObject({
 netSalesCents:cents.nullable(),salesPeriod:period.nullable(),
 laborCents:cents.nullable(),laborPeriod:period.nullable(),
 rentCents:cents.nullable(),otherOverheadCents:cents.nullable(),overheadPeriod:period.nullable(),
 unitCostCents:cents.nullable(),itemsSoldPerDay:z.number().positive().finite().nullable(),
});
export type OwnerInputs=z.infer<typeof ownerInputsSchema>;
export const emptyOwnerInputs:OwnerInputs={
 netSalesCents:null,salesPeriod:null,laborCents:null,laborPeriod:null,
 rentCents:null,otherOverheadCents:null,overheadPeriod:null,unitCostCents:null,itemsSoldPerDay:null,
};
export function ownerPeriod(value:OwnerInputs["salesPeriod"],asOf:string):CalcPeriod|null{
 if(!value)return null;
 if("days" in value){
  return {from:dateOffset(asOf,-value.days+1),to:asOf};
 }
 if(value.from>value.to)throw new Error("Invalid owner period");
 return value;
}
export function ownerAmountForPeriod(amount:number|null,source:OwnerInputs["salesPeriod"],target:CalcPeriod,asOf:string){
 if(amount===null)return null;
 const from=ownerPeriod(source,asOf);
 return from?prorate(amount,from,target):null;
}
export function ownerMonthlyAmount(amount:number|null,target:CalcPeriod,asOf:string){
 return amount===null?null:prorate(amount,calendarMonth(asOf),target);
}
export function ownerConflict(recorded:number|null,owner:number|null):boolean{
 return recorded!==null&&owner!==null&&Math.abs(recorded-owner)>0.2*Math.max(1,Math.abs(recorded));
}
