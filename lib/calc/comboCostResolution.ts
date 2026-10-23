import type {RecipeCostStatus} from "./ingredients";

export type ComboCostComponent={
 comboItemId:string;
 componentItemId:string;
 quantity:number;
 buyInCostCents:number|null;
};
export type CostedComponent={costCents:number|null;status:RecipeCostStatus;estimated:boolean};
export type ResolvedComboCost={costCents:number|null;status:RecipeCostStatus;estimated:boolean};

/** Single source of truth for combo food cost, independent of the screen rendering it.
 * Unknown costs propagate; an owner's buy-in override is a known cost, and an estimated
 * component remains estimated. Recursion/corrupt references fail closed. */
export function resolveComboCosts(
 rows:readonly ComboCostComponent[],
 baseCosts:ReadonlyMap<string,CostedComponent>,
):Map<string,ResolvedComboCost>{
 const groups=new Map<string,ComboCostComponent[]>();
 for(const row of rows){
  const arr=groups.get(row.comboItemId)??[];
  arr.push(row);groups.set(row.comboItemId,arr);
 }
 const output=new Map<string,ResolvedComboCost>();
 for(const [comboId,parts] of groups){
  let raw=0,estimated=false,unknown=false;
  for(const part of parts){
   if(part.componentItemId===comboId||groups.has(part.componentItemId)||!Number.isSafeInteger(part.quantity)||part.quantity<1||part.quantity>100){
    unknown=true;continue;
   }
   const source=baseCosts.get(part.componentItemId);
   const cost=part.buyInCostCents??(source?.status==="READY"?source.costCents:null);
   if(cost===null||cost===undefined||!Number.isFinite(cost)||cost<0){
    unknown=true;continue;
   }
   raw+=part.quantity*cost;
   estimated ||= part.buyInCostCents===null&&Boolean(source?.estimated);
  }
  output.set(comboId,unknown||parts.length===0?{status:"MISSING_INGREDIENT_COST",costCents:null,estimated:false}:
   {status:"READY",costCents:raw,estimated});
 }
 return output;
}
