/** React editor identity depends on saved recipe facts, not price or serving state.
 * This prevents an in-place price or active-status refresh from discarding drafts. */
type SavedRecipeLine={
 ingredientId:string;quantity:number;displayUnit?:string|null;displayQuantity?:number|null;
};
type SavedRecipeSize={id:string;recipe:readonly SavedRecipeLine[];priceCents?:number;active?:boolean};
export function recipeEditorKey(items:readonly SavedRecipeSize[]):string{
 return JSON.stringify(items.map(item=>[
  item.id,item.recipe.map(line=>[
   line.ingredientId,line.quantity,line.displayUnit??null,line.displayQuantity??null,
  ]),
 ]));
}
