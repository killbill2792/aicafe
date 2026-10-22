import { buildTemplateRecipe } from "@/lib/calc/recipeScaling";
import type { ScalingLine } from "@/lib/calc/recipeScaling";
export { shotsForSize, halfOunce, scaledTemplateLines } from "@/lib/calc/recipeScaling";

export const HOT_SIZES = [8, 12, 16, 20] as const;
export const ICED_SIZES = [16, 20, 24] as const;
export type RecipeTemplateKey =
  | "latte" | "cappuccino" | "flat-white" | "cortado" | "americano" | "mocha"
  | "macchiato" | "iced-latte" | "cold-brew" | "drip" | "chai-latte" | "matcha-latte" | "hot-tea";
export type TemplateLine = ScalingLine;
export type RecipeTemplate = { key: RecipeTemplateKey; name: string; iced: boolean; defaultMilkKey: string | null };
export const RECIPE_TEMPLATES: readonly RecipeTemplate[] = [
  { key: "latte", name: "Latte", iced: false, defaultMilkKey: "milk-whole" },
  { key: "cappuccino", name: "Cappuccino", iced: false, defaultMilkKey: "milk-whole" },
  { key: "flat-white", name: "Flat white", iced: false, defaultMilkKey: "milk-whole" },
  { key: "cortado", name: "Cortado", iced: false, defaultMilkKey: "milk-whole" },
  { key: "americano", name: "Americano", iced: false, defaultMilkKey: null },
  { key: "mocha", name: "Mocha", iced: false, defaultMilkKey: "milk-whole" },
  { key: "macchiato", name: "Caramel macchiato", iced: false, defaultMilkKey: "milk-whole" },
  { key: "iced-latte", name: "Iced latte", iced: true, defaultMilkKey: "milk-whole" },
  { key: "cold-brew", name: "Cold brew", iced: true, defaultMilkKey: null },
  { key: "drip", name: "Drip coffee", iced: false, defaultMilkKey: null },
  { key: "chai-latte", name: "Chai latte", iced: false, defaultMilkKey: "milk-whole" },
  { key: "matcha-latte", name: "Matcha latte", iced: false, defaultMilkKey: "milk-whole" },
  { key: "hot-tea", name: "Hot tea", iced: false, defaultMilkKey: null },
];
export const RECIPE_TEMPLATES_BY_KEY = new Map(RECIPE_TEMPLATES.map((template) => [template.key, template]));

/** Metadata only: quantity arithmetic is pure code in lib/calc/recipeScaling.ts. */
export function recipeSizesFor(key: RecipeTemplateKey): readonly number[] {
  return RECIPE_TEMPLATES_BY_KEY.get(key)?.iced ? ICED_SIZES : HOT_SIZES;
}
export function templateRecipeForSize(key: RecipeTemplateKey, sizeOz: number): TemplateLine[] | null {
  const template = RECIPE_TEMPLATES_BY_KEY.get(key);
  if (!template || !recipeSizesFor(key).includes(sizeOz)) return null;
  return buildTemplateRecipe(key, sizeOz, template.iced, template.defaultMilkKey);
}
