/** All add-on money comes from the same ingredient micro-cent prices as recipes. */
export function additiveCostCents(quantityInBase:number,costPerBaseMicros:number|null):number|null{
 if(costPerBaseMicros===null||!Number.isFinite(costPerBaseMicros)||costPerBaseMicros<0)return null;
 if(!Number.isFinite(quantityInBase)||quantityInBase<0)throw new RangeError("Invalid quantity");
 return quantityInBase*costPerBaseMicros/1_000_000;
}
export function replacementDifferenceCents(quantityInBase:number,oldUnitMicros:number|null,newUnitMicros:number|null):number|null{
 const oldCost=additiveCostCents(quantityInBase,oldUnitMicros),newCost=additiveCostCents(quantityInBase,newUnitMicros);
 return oldCost===null||newCost===null?null:newCost-oldCost;
}
export function keepFromAddon(upchargeCents:number,addedCostCents:number|null):number|null{
 if(!Number.isSafeInteger(upchargeCents)||upchargeCents<0)throw new RangeError("Invalid upcharge");
 return addedCostCents===null?null:Math.round(upchargeCents-addedCostCents);
}

/** Compare physical portions that may have different shot/pump conversions. */
export function swapPortionDifferenceCents(sourceBaseQuantity:number,sourceMicros:number|null,targetBaseQuantity:number,targetMicros:number|null):number|null{
 const source=additiveCostCents(sourceBaseQuantity,sourceMicros),target=additiveCostCents(targetBaseQuantity,targetMicros);
 return source===null||target===null?null:target-source;
}
