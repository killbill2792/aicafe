export type ObservedModifier={
 provider:"toast"|"square"|"csv";locationRef:string;posModifierId:string;name:string
};
export type RecipeCandidate={
 id:string;name:string;ingredientId:string|null;ingredientName:string|null;
 unit:"g"|"ml"|"each"|null;quantityDelta:number
};
export type ModifierSuggestion=ObservedModifier&{
 recipeId:string;recipeName:string;ingredientName:string;quantityDelta:number;unit:string
};
/** One source-neutral matching policy. No auto-links: this only creates previews. */
function canonical(text:string):string {
 return text.normalize("NFKD").toLocaleLowerCase().replace(/[\u0300-\u036f]/g,"")
  .replace(/[^a-z0-9\u0600-\u06ff]+/g," ").trim().replace(/\s+/g," ");
}
function hintedUnit(name:string):"g"|"ml"|"each"|null{
 const text=canonical(name);
 if(/\b(oz|ounce|gram|grams|lb|kg)\b/.test(text))return "g";
 if(/\b(ml|liter|litre|gallon|gal|fl oz)\b/.test(text))return "ml";
 return null;
}
export function suggestModifierLinks(observed:readonly ObservedModifier[],recipes:readonly RecipeCandidate[],
 mapped:ReadonlySet<string>):ModifierSuggestion[]{
 const results:ModifierSuggestion[]=[];
 for(const item of observed){
  const key=[item.provider,item.locationRef.toLowerCase(),item.posModifierId.toLowerCase()].join(":");
  if(!item.locationRef||!item.posModifierId||mapped.has(key))continue;
  const text=canonical(item.name);
  if(!text)continue;
  const unitHint=hintedUnit(item.name);
  const scored=recipes.filter(r=>r.ingredientId&&r.unit&&Number.isFinite(r.quantityDelta)&&r.quantityDelta!==0)
   .filter(r=>!unitHint||unitHint===r.unit).map(r=>{
    const candidate=canonical(r.name);
    const score=candidate===text?100:
      candidate&&text.includes(candidate)&&candidate.length>=5?84:
      candidate&&candidate.includes(text)&&text.length>=5?80:0;
    return {recipe:r,score};
   }).filter(x=>x.score>=80).sort((a,b)=>b.score-a.score);
  // Never one-tap a tied or close second: a wrong link corrupts usage variance.
  if(!scored.length||scored[1]&&scored[0].score-scored[1].score<20)continue;
  const recipe=scored[0].recipe;
  results.push({...item,recipeId:recipe.id,recipeName:recipe.name,
   ingredientName:recipe.ingredientName??recipe.name,quantityDelta:recipe.quantityDelta,unit:recipe.unit!});
 }
 return results;
}
export function modifierLinkKey(row:ObservedModifier):string{
 return [row.provider,row.locationRef.toLowerCase(),row.posModifierId.toLowerCase()].join(":");
}
