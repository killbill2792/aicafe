/** A list price is not an observed sale price. All comparisons stay in cents. */
export function priceCheck(listCents:number,realizedAvgCents:number|null):"ok"|"differs"{
 if(realizedAvgCents===null||realizedAvgCents<=0||listCents<=0)return "ok";
 return Math.abs(listCents-realizedAvgCents)>100&&
   Math.abs(listCents-realizedAvgCents)/realizedAvgCents>0.25?"differs":"ok";
}
export function priceSource(history:string|null,catalog:string|null):"owner_manual"|"connected_pos"|"imported_avg"|"initial"{
 if(history==="owner_manual")return "owner_manual";
 if(history==="connected_pos")return "connected_pos";
 if(history==="initial")return "initial";
 if(history==="imported"||catalog==="csv")return "imported_avg";
 if(catalog==="toast"||catalog==="square"||catalog==="clover")return "connected_pos";
 return "initial";
}
