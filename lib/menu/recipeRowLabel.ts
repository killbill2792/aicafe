/** The recipe row keeps its original ingredient ID until Save, while the
 * pending replacement is the ingredient the owner will actually save. All
 * viewport labels must display that draft identity, scoped to the size. */
export function recipeRowDisplayName(
 sizeId:string,originalIngredientId:string,originalName:string,
 replacements:Readonly<Record<string,string>>,
 ingredients:readonly {id:string;name:string}[],
):string{
 const selected=replacements[sizeId+":"+originalIngredientId];
 return selected?ingredients.find(i=>i.id===selected)?.name??originalName:originalName;
}
