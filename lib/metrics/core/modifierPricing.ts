/** Pure provider-neutral milk/modifier math, suitable for screens and chat tools. */
export type ModifierBasis="recorded"|"owner_provided"|"estimated"|"missing";
export const DEFAULT_TARGET_PRODUCT_COST_PERCENT=0.30;
export type MilkSize={id:string;label:string};
export type MilkUnitCost={costPerMlMicros:number|null;basis:ModifierBasis};
export type SizeMilkVolume={ml:number|null;basis:ModifierBasis};
export type MilkSwapLine={
  sizeId:string;sizeLabel:string;milkMl:number|null;
  costDeltaCents:number|null;suggestedUpchargeCents:number|null;
  marginKeptCents:number|null;
  targetProductCostPercent:number|null;roundingStepCents:number;
  basis:{fromMilk:ModifierBasis;toMilk:ModifierBasis;milkMl:ModifierBasis;
    targetProductCost:ModifierBasis};
  missing:string[];
};
const validCost=(x:number|null|undefined):x is number=>x!==null&&x!==undefined&&
  Number.isSafeInteger(x)&&x>=0;
/** A negative added cost is a saving. Never invent a negative customer upcharge. */
export function keepFromAddon(upchargeCents:number,addedCostCents:number|null):number|null{
  if(!Number.isSafeInteger(upchargeCents)||upchargeCents<0)throw new RangeError("Invalid upcharge");
  return addedCostCents===null?null:Math.round(upchargeCents-addedCostCents);
}
export function swapCostPerSize(
  sizes:readonly MilkSize[],fromMilk:string,toMilk:string,
  mlPerSize:Readonly<Record<string,SizeMilkVolume|number|null>>,
  costs:Readonly<Record<string,MilkUnitCost|undefined>>,
  targetProductCostPercent:number|null=DEFAULT_TARGET_PRODUCT_COST_PERCENT,
  targetBasis:ModifierBasis="estimated",
):{sizes:MilkSwapLine[];missing:string[]}{
  if(!fromMilk||!toMilk)throw new RangeError("Milk IDs required");
  const roundingStepCents=5;
  const seen=new Set<string>();
  const out=sizes.map(size=>{
    if(seen.has(size.id))throw new RangeError("Duplicate size");
    seen.add(size.id);
    const rawMl=mlPerSize[size.id];
    const volume=typeof rawMl==="number"||rawMl===null||rawMl===undefined?
      {ml:rawMl??null,basis:(rawMl===null||rawMl===undefined?"missing":"recorded") as ModifierBasis}:rawMl;
    const from=costs[fromMilk],to=costs[toMilk];
    const missing:string[]=[];
    if(!from||!validCost(from.costPerMlMicros))missing.push("milk_cost:"+fromMilk);
    if(!to||!validCost(to.costPerMlMicros))missing.push("milk_cost:"+toMilk);
    if(!(volume.ml!==null&&Number.isFinite(volume.ml)&&volume.ml>0))
      missing.push("milk_ml:"+size.label);
    if(!(targetProductCostPercent!==null&&Number.isFinite(targetProductCostPercent)&&
      targetProductCostPercent>0&&targetProductCostPercent<=1))
      missing.push("target_product_cost_percent");
    let costDeltaCents:number|null=null,suggestedUpchargeCents:number|null=null;
    let marginKeptCents:number|null=null;
    if(!missing.length){
      // Microcents/ml source basis; round to integer cents only after multiplying the portion.
      costDeltaCents=Math.round(volume.ml!*(to!.costPerMlMicros!-from!.costPerMlMicros!)/1_000_000);
      suggestedUpchargeCents=Math.ceil(Math.max(0,costDeltaCents)/
        targetProductCostPercent!/roundingStepCents)*roundingStepCents;
      marginKeptCents=keepFromAddon(suggestedUpchargeCents,costDeltaCents);
    }
    return {sizeId:size.id,sizeLabel:size.label,milkMl:volume.ml,
      costDeltaCents,suggestedUpchargeCents,marginKeptCents,
      targetProductCostPercent,roundingStepCents,
      basis:{fromMilk:from?.basis??"missing",toMilk:to?.basis??"missing",
        milkMl:volume.basis,targetProductCost:targetBasis},missing};
  });
  return {sizes:out,missing:[...new Set(out.flatMap(item=>item.missing))]};
}
