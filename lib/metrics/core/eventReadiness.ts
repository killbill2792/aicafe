/** All event-day hourly money aggregation stays in the canonical metrics layer. */
export type HourRevenue={date:string;hourLocal:number;netSalesCents:number};
export function indexHourlyRevenue(rows:readonly HourRevenue[]):Map<string,Map<number,number>>{
 const days=new Map<string,Map<number,number>>();
 for(const row of rows){
  if(!Number.isSafeInteger(row.netSalesCents)||!Number.isInteger(row.hourLocal)||
    row.hourLocal<0||row.hourLocal>23)throw new Error("Invalid hourly sales fact");
  const byHour=days.get(row.date)??new Map<number,number>();
  const cents=(byHour.get(row.hourLocal)??0)+row.netSalesCents;
  if(!Number.isSafeInteger(cents))throw new Error("Hourly money exceeds safe integer cents");
  byHour.set(row.hourLocal,cents);
  days.set(row.date,byHour);
 }
 return days;
}
export function hourlyMatchesDaily(rows:ReadonlyMap<number,number>|undefined,dailyCents:number):boolean{
 if(!rows||!Number.isSafeInteger(dailyCents))return false;
 let total=0;
 for(const cents of rows.values()){
  total+=cents;
  if(!Number.isSafeInteger(total))return false;
 }
 return total===dailyCents;
}
