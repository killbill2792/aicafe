/** The same explicit-sales/positive-evidence rule used by the existing day windows.
 * A positive legacy import remains usable even if its coverage flag was not set.
 * A truly missing zero-valued row stays unknown, never treated as recorded $0.
 */
export function hasCoveredSales(day:{
  salesDataStatus?:"actual"|"missing";
  netSalesCents:number;ordersCount?:number|null;drinksCount?:number|null;
}):boolean{
  if(day.salesDataStatus==="actual")return true;
  if(day.netSalesCents!==0||(day.ordersCount??0)>0||(day.drinksCount??0)>0)return true;
  return day.salesDataStatus!=="missing";
}
