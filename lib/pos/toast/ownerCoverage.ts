/**
 * Business-day coverage is a function of the date, not the current number
 * of connected restaurants. Only verified locations applicable ON THAT DATE
 * must contribute to the aggregate. Keep this in sync with
 * public.toast_is_complete_business_day in migration 095.
 */
export type ToastMapping={
 restaurant_guid:string;verified_at:string|null;toast_start_date:string|null;
};
export type ToastDay={
 business_date:string;restaurant_guid:string;import_state:string;
 coverage_complete:boolean;net_sales_cents:number|null;order_count:number|null;
 recon_state?:string;toast_net_sales_cents?:number|null;
};
export function applicableLocations(mappings:readonly ToastMapping[],date:string){
 return mappings.filter(m=>m.verified_at!==null &&
  (!m.toast_start_date||date>=m.toast_start_date));
}
export function dayCoverage(mappings:readonly ToastMapping[],days:readonly ToastDay[],date:string){
 const eligible=applicableLocations(mappings,date);
 const byGuid=new Map(days.filter(row=>row.business_date===date)
  .map(row=>[row.restaurant_guid,row]));
 const rows=eligible.map(m=>byGuid.get(m.restaurant_guid));
 return {eligible,rows,complete:eligible.length>0&&rows.every(row=>
  row?.import_state==="imported"&&row.coverage_complete===true)};
}
export function dayTotals(mappings:readonly ToastMapping[],days:readonly ToastDay[],date:string){
 const proof=dayCoverage(mappings,days,date);
 const complete=proof.complete;
 const known=complete&&proof.rows.every(row=>
  row&&Number.isSafeInteger(row.net_sales_cents)&&Number.isSafeInteger(row.order_count));
 return {
  complete,
  netSalesCents:known?proof.rows.reduce((n,row)=>n+(row!.net_sales_cents as number),0):null,
  orders:known?proof.rows.reduce((n,row)=>n+(row!.order_count as number),0):null,
  checked:complete&&proof.rows.every(row=>row&&["matched","checked_internal"].includes(row.recon_state??""))
 };
}
