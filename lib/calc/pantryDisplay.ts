import type {BaseUnit} from "./recipeUnits";
export function pantryUnitCostCents(costPerBaseMicros:number|null,baseUnit:BaseUnit):{costCents:number;unit:"fl_oz"|"oz_wt"|"each"}|null{
 if(costPerBaseMicros===null||!Number.isFinite(costPerBaseMicros)||costPerBaseMicros<0)return null;
 const factor=baseUnit==="ml"?29.5735295625:baseUnit==="g"?28.349523125:1;
 return{costCents:costPerBaseMicros*factor/1_000_000,unit:baseUnit==="ml"?"fl_oz":baseUnit==="g"?"oz_wt":"each"};
}
