/** Snapshot-price illustration, not historical POS line-item revenue.
 * The menu price may have changed after the recorded quantities were sold. */
export function estimatedItemRevenueCents(units:number,currentPriceCents:number):number|null{
 if(!Number.isSafeInteger(units)||units<0||
   !Number.isSafeInteger(currentPriceCents)||currentPriceCents<0)return null;
 const revenue=units*currentPriceCents;
 return Number.isSafeInteger(revenue)?revenue:null;
}
