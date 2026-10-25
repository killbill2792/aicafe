/** A list price is not an observed sale price. All comparisons stay in cents. */
export function priceCheck(listCents:number,realizedAvgCents:number|null):"ok"|"differs"{
 if(realizedAvgCents===null||realizedAvgCents<=0||listCents<=0)return "ok";
 return Math.abs(listCents-realizedAvgCents)>100&&
   Math.abs(listCents-realizedAvgCents)/realizedAvgCents>0.25?"differs":"ok";
}
export function priceSource(history:string|null,catalog:string|null):"owner_manual"|"connected_pos"|"imported_avg"|"initial"{
 if(history==="owner_manual")return "owner_manual";
 if(history==="connected_pos")return "connected_pos";
 if(history==="imported"||catalog==="csv")return "imported_avg";
 if(catalog==="toast"||catalog==="square"||catalog==="clover")return "connected_pos";
 return "initial";
}

/** Pure realized price aggregation: net sales may include discounts or modifiers. */
export function realizedUnitAverage(rows:ReadonlyArray<{net_sales_cents:number;quantity:number}>):number|null{
 let sales=0,units=0;
 for(const row of rows){
  if(!Number.isSafeInteger(row.net_sales_cents)||!Number.isFinite(row.quantity)||row.quantity<=0)continue;
  sales+=row.net_sales_cents;units+=row.quantity;
 }
 if(units<=0||!Number.isSafeInteger(sales))return null;
 const average=Math.round(sales/units);
 return Number.isSafeInteger(average)&&average>0?average:null;
}
