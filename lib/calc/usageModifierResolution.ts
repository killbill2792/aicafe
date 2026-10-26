import type {UsageModifier} from "./usageVariance";

/** IDs are unique only within each provider and restaurant/location, never globally.
 * Missing source identity must not fall back to a bare modifier id. */
export function scopedModifierId(provider:"toast"|"square"|"csv",locationRef:string|null,modifierId:string):string|null{
 if(!locationRef||!modifierId)return null;
 return provider+":"+locationRef.toLowerCase()+":"+modifierId.toLowerCase();
}
export function scopedToastModifierId(restaurantGuid:string|null,modifierGuid:string):string|null{
 return scopedModifierId("toast",restaurantGuid,modifierGuid);
}
export type CatalogModifierLink={restaurantGuid?:string;provider?:"toast"|"square"|"csv";locationRef?:string;posModifierId:string;recipeId:string};
export type ApprovedModifierRecipe={id:string;ingredientId:string|null;quantityDelta:number;replacesIngredientId:string|null;posModifierId?:string|null};

/** Fail closed on missing or conflicting restaurant-specific approval links.
 * Legacy bare GUID aliases intentionally cannot bypass restaurant scope. */
export function scopedToastModifierRecipes(
 links:readonly CatalogModifierLink[],recipes:readonly ApprovedModifierRecipe[]
):Map<string,UsageModifier>{
 const byRecipe=new Map(recipes.map(r=>[r.id,r]));
 const linked=new Map<string,UsageModifier>();
 const ambiguous=new Set<string>();
 const register=(key:string|null,r:ApprovedModifierRecipe|undefined)=>{
  if(!key||!r||!Number.isFinite(r.quantityDelta)||r.quantityDelta<0)return;
  const next:UsageModifier={posModifierId:key,ingredientId:r.ingredientId,
   quantityDelta:r.quantityDelta,replacesIngredientId:r.replacesIngredientId};
  const existing=linked.get(key);
  if(existing&&(existing.ingredientId!==next.ingredientId||
   existing.quantityDelta!==next.quantityDelta||
   existing.replacesIngredientId!==next.replacesIngredientId))ambiguous.add(key);
  else linked.set(key,next);
 };
 for(const r of recipes){
  const match=r.posModifierId?.match(/^(toast|square|csv):([^:]+):(.+)$/i);
  if(match)register(scopedModifierId(match[1].toLowerCase() as "toast"|"square"|"csv",match[2],match[3]),r);
 }
 for(const link of links){
  register(scopedModifierId(link.provider??"toast",link.locationRef??link.restaurantGuid??null,link.posModifierId),
   byRecipe.get(link.recipeId));
 }
 for(const key of ambiguous)linked.delete(key);
 return linked;
}

/** Milk selectors store displayQuantity=1 as a UI placeholder. Only the
 * sold size's recipe establishes the actual replacement amount. If the base
 * units differ (e.g. g vs ml), do not invent density or a conversion. */
export function sizedMilkReplacementQuantity(
 recipeLines:readonly {ingredientId:string;quantity:number}[],
 sourceMilkId:string,sourceUnit:string,targetUnit:string
):number|null{
 if(!sourceMilkId||!["g","ml","each"].includes(sourceUnit)||sourceUnit!==targetUnit)return null;
 const lines=recipeLines.filter(line=>line.ingredientId===sourceMilkId);
 if(!lines.length||lines.some(line=>!Number.isFinite(line.quantity)||line.quantity<0))return null;
 const quantity=lines.reduce((sum,line)=>sum+line.quantity,0);
 return quantity>0&&Number.isFinite(quantity)?quantity:null;
}
