import {toBaseUnitQuantity,type BaseUnit,type IngredientUnitConversion,type RecipeDisplayUnit} from "./recipeUnits";
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

/** Same per-base cost as the footer, only scaled to a draft displayed amount. */
export function draftLineCostCents(originalCostCents:number|null,originalDisplayAmount:number,newDisplayAmount:number):number|null{
 if(originalCostCents===null||!(originalDisplayAmount>0)||!Number.isFinite(newDisplayAmount)||newDisplayAmount<0)return null;
 return originalCostCents*newDisplayAmount/originalDisplayAmount;
}

/** Cost every editor cell and the whole footer from the exact same canonical
 * base-unit quantities that P1 persists, including fractional unit changes. */
export type DraftRecipeCostLine={
 ingredientId:string;originalBaseQuantity:number;baseUnit:BaseUnit;costCents:number|null;
 displayUnit:RecipeDisplayUnit;displayQuantity:number;removed:boolean;
 conversions:readonly IngredientUnitConversion[];
};
export function draftRecipeCosts(lines:readonly DraftRecipeCostLine[]):{
 costCents:number|null;lineCosts:Record<string,number|null>;estimated:boolean;
}{
 let total=0,hasLines=false,missing=false;
 const lineCosts:Record<string,number|null>={};
 for(const line of lines){
  if(line.removed||line.displayQuantity===0)continue;
  hasLines=true;
  const quantity=toBaseUnitQuantity(line.displayUnit,line.displayQuantity,line.baseUnit,[...line.conversions]);
  if(quantity===null||!Number.isFinite(quantity)||!(line.originalBaseQuantity>0)
    ||line.costCents===null||!Number.isFinite(line.costCents)){
   lineCosts[line.ingredientId]=null;missing=true;continue;
  }
  const value=line.costCents*quantity/line.originalBaseQuantity;
  if(!Number.isFinite(value)){lineCosts[line.ingredientId]=null;missing=true;continue;}
  lineCosts[line.ingredientId]=value;total+=value;
 }
 return {costCents:hasLines&&!missing?total:null,lineCosts,estimated:!hasLines||missing};
}
