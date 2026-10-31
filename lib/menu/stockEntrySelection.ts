/** Never silently redirect a stale stock-entry ID to the first visible option.
 * Archiving filters options after a server refresh, but React retains draft
 * state; submitting that old ID would overwrite the archived ingredient's
 * count while the browser appears to show a different ingredient.
 * Historical records have their own edit path and remain readable. */
export function selectedActiveIngredient<T extends {id:string;archivedAt?:string|null}>(
 items:readonly T[],selectedId:string|null|undefined,
):T|null{
 return items.find(item=>item.id===selectedId&&!item.archivedAt)??null;
}
