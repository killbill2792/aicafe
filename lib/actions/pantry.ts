"use server";

import { saveUsageEntry as writeUsage } from "@/lib/data/usageVariance.server";
import { revalidatePath } from "next/cache";
import {
  listPantry as readPantry,
  addFromStarter as insertStarters,
  savePackPrice as insertPackPrice,
  previewPriceImpact as calculatePricePreview,
  applyTemplate as applySizedRecipe,
  swapIngredient as replaceIngredient,
  scaleRecipeToSize as rescaleItemRecipe,
  saveProductRecipes as persistProductRecipes,
  createPantryIngredient as insertCustomPantry,
  updatePantryIngredient as editCustomPantry,
} from "@/lib/data/pantry.server";
import type { RecipeTemplateKey } from "@/lib/menu/recipeTemplates";

function invalidatePantry(): void {
  revalidatePath("/menu");
  revalidatePath("/menu/manage");
  revalidatePath("/money");
  revalidatePath("/");
}

export async function listPantry(): Promise<Awaited<ReturnType<typeof readPantry>>> {
  return readPantry();
}
export async function addFromStarter(keys: string[]): Promise<Awaited<ReturnType<typeof insertStarters>>> {
  const result = await insertStarters(keys);
  if (result.ok) invalidatePantry();
  return result;
}
export async function savePackPrice(input: Parameters<typeof insertPackPrice>[0]): Promise<Awaited<ReturnType<typeof insertPackPrice>>> {
  const result = await insertPackPrice(input);
  if (result.ok) invalidatePantry();
  return result;
}
export async function previewPriceImpact(input: Parameters<typeof calculatePricePreview>[0]): Promise<Awaited<ReturnType<typeof calculatePricePreview>>> {
  return calculatePricePreview(input);
}
export async function applyTemplate(productId: string, templateKey: RecipeTemplateKey): Promise<Awaited<ReturnType<typeof applySizedRecipe>>> {
  const result = await applySizedRecipe(productId, templateKey);
  if (result.ok) invalidatePantry();
  return result;
}
export async function swapIngredient(productId: string, fromId: string, toId: string): Promise<Awaited<ReturnType<typeof replaceIngredient>>> {
  const result = await replaceIngredient(productId, fromId, toId);
  if (result.ok) invalidatePantry();
  return result;
}
export async function scaleRecipeToSize(fromItemId: string, toItemId: string): Promise<Awaited<ReturnType<typeof rescaleItemRecipe>>> {
  const result = await rescaleItemRecipe(fromItemId, toItemId);
  if (result.ok) invalidatePantry();
  return result;
}

export async function saveProductRecipes(input: Parameters<typeof persistProductRecipes>[0]):Promise<Awaited<ReturnType<typeof persistProductRecipes>>>{
 const result=await persistProductRecipes(input);if(result.ok)invalidatePantry();return result;
}

export async function createPantryIngredient(input:Parameters<typeof insertCustomPantry>[0]):Promise<Awaited<ReturnType<typeof insertCustomPantry>>>{
 const result=await insertCustomPantry(input);if(result.ok)invalidatePantry();return result;
}
export async function updatePantryIngredient(input:Parameters<typeof editCustomPantry>[0]):Promise<Awaited<ReturnType<typeof editCustomPantry>>>{
 const result=await editCustomPantry(input);if(result.ok)invalidatePantry();return result;
}

export async function saveUsageEntry(kind:"count"|"purchase",input:unknown){const result=await writeUsage(kind,input);if(result.ok){revalidatePath("/menu/pantry");revalidatePath("/");}return result;}
