import { evaluateRecipeCost } from "@/lib/calc/ingredients";
export type CostLine={ingredientId:string;quantity:number;displayQuantity:number|null;costCents:number|null};
export function recipePreviewCost(lines:readonly CostLine[],amounts:Record<string,number>):{costCents:number|null;estimated:boolean}{
 const prices:Record<string,number>={};
 for(const line of lines){if(line.costCents===null||!(line.quantity>0))return{costCents:null,estimated:true};
 prices[line.ingredientId]=line.costCents/line.quantity*1_000_000;}
 const recipe=lines.filter(line=>(amounts[line.ingredientId]??line.displayQuantity??line.quantity)>0)
 .map(line=>({ingredientId:line.ingredientId,quantity:line.quantity*(amounts[line.ingredientId]??line.displayQuantity??line.quantity)/(line.displayQuantity??line.quantity)}));
 const value=evaluateRecipeCost(recipe,prices);return{costCents:value.costCents,estimated:value.status!=="READY"};
}
export function keepPreview(priceCents:number,costCents:number|null):{keepCents:number|null;keepPercent:number|null}{
 if(costCents===null||!Number.isFinite(priceCents)||priceCents<=0)return{keepCents:null,keepPercent:null};
 return{keepCents:Math.round(priceCents-costCents),keepPercent:Math.round((priceCents-costCents)*100/priceCents)};
}
