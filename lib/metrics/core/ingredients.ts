/** Ingredient cost the owner estimates as a share of sales ("20% of price for all").
 * Cents only. Returns null for invalid input; never a zero stand-in. */
export function ingredientCostFromSalesShareCents(netSalesCents:number,shareBps:number):number|null{
  if(!Number.isSafeInteger(netSalesCents)||netSalesCents<0||
    !Number.isSafeInteger(shareBps)||shareBps<0||shareBps>=10000)return null;
  // Round half up with integer math so large sales never lose precision.
  const cents=(BigInt(netSalesCents)*BigInt(shareBps)+BigInt(5000))/BigInt(10000);
  return cents>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(cents);
}

/** Known costs with the recorded ingredient part swapped for the owner's estimate. */
export function knownCostsWithIngredientEstimateCents(input:{
  knownTotalCents:number;recordedIngredientsCents:number;estimatedIngredientsCents:number;
}):number|null{
  const {knownTotalCents,recordedIngredientsCents,estimatedIngredientsCents}=input;
  if(![knownTotalCents,recordedIngredientsCents,estimatedIngredientsCents]
    .every(v=>Number.isSafeInteger(v)&&v>=0)||recordedIngredientsCents>knownTotalCents)return null;
  const total=knownTotalCents-recordedIngredientsCents+estimatedIngredientsCents;
  return Number.isSafeInteger(total)?total:null;
}
