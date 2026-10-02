type RecipeItem = { id: string; sizeLabel: string | null; recipe: { ingredientId: string; quantity: number }[] };

export function identicalDifferentSizeRecipe(item: RecipeItem, siblings: RecipeItem[]): string | null {
  if (item.recipe.length === 0) return null;
  const signature = recipeSignature(item.recipe);
  return siblings.find((sibling) => sibling.sizeLabel !== item.sizeLabel && recipeSignature(sibling.recipe) === signature)?.sizeLabel ?? null;
}

function recipeSignature(lines: RecipeItem["recipe"]): string {
  return [...lines].sort((a, b) => a.ingredientId.localeCompare(b.ingredientId)).map((line) => `${line.ingredientId}:${line.quantity}`).join("|");
}
