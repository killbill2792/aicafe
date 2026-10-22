import type { BaseUnit } from "@/lib/calc/recipeUnits";

/** Typical retail/foodservice pack sizes, not prices or guaranteed supplier specifications.
 * Owner-entered pack price is always required. Never seed a cost from an industry average. */
export type PantryCategory = "coffee" | "milk" | "syrup" | "sauce" | "powder" | "tea" | "packaging" | "bakery" | "food" | "other";
export type StarterIngredient = {
  key: string;
  name: string;
  category: PantryCategory;
  baseUnit: BaseUnit;
  packQuantity: number;
  packUnit: string;
  operationalUnit?: "shot" | "pump";
  baseUnitsPerOperationalUnit?: number;
};
const milk = (key: string, name: string, ounces: number): StarterIngredient => ({
  key, name, category: "milk", baseUnit: "ml", packQuantity: ounces === 128 ? 1 : ounces, packUnit: ounces === 128 ? "gal" : "fl_oz",
});
const syrup = (key: string, name: string): StarterIngredient => ({
  key, name, category: "syrup", baseUnit: "ml", packQuantity: 750, packUnit: "ml",
  operationalUnit: "pump", baseUnitsPerOperationalUnit: 7.5,
});
const sauce = (key: string, name: string): StarterIngredient => ({
  key, name, category: "sauce", baseUnit: "ml", packQuantity: 64, packUnit: "fl_oz",
  operationalUnit: "pump", baseUnitsPerOperationalUnit: 15,
});
const cup = (kind: "hot" | "cold", ounces: number): StarterIngredient => ({
  key: `cup-${kind}-${ounces}`, name: `${kind === "hot" ? "Hot" : "Cold"} cup ${ounces} oz`,
  category: "packaging", baseUnit: "each", packQuantity: 1, packUnit: "case(1000)",
});
export const PANTRY_STARTERS: readonly StarterIngredient[] = [
  milk("milk-whole", "Whole milk", 128),
  milk("milk-2-percent", "2% milk", 128),
  milk("milk-skim", "Skim milk", 128),
  milk("milk-oat", "Oat milk", 64),
  milk("milk-almond", "Almond milk", 64),
  milk("milk-soy", "Soy milk", 64),
  milk("milk-coconut", "Coconut milk", 64),
  milk("half-and-half", "Half & half", 32),
  milk("heavy-cream", "Heavy cream", 32),
  { key: "espresso-beans", name: "Espresso beans", category: "coffee", baseUnit: "g", packQuantity: 5, packUnit: "lb",
    operationalUnit: "shot", baseUnitsPerOperationalUnit: 18 },
  { key: "drip-coffee", name: "Drip coffee beans", category: "coffee", baseUnit: "g", packQuantity: 5, packUnit: "lb" },
  { key: "cold-brew-concentrate", name: "Cold brew concentrate", category: "coffee", baseUnit: "ml", packQuantity: 1, packUnit: "gal" },
  syrup("syrup-vanilla", "Vanilla syrup"),
  syrup("syrup-caramel", "Caramel syrup"),
  syrup("syrup-hazelnut", "Hazelnut syrup"),
  syrup("syrup-vanilla-sugar-free", "Sugar-free vanilla syrup"),
  sauce("sauce-mocha", "Mocha sauce"),
  sauce("sauce-white-mocha", "White mocha sauce"),
  sauce("sauce-caramel", "Caramel sauce"),
  { key: "matcha", name: "Matcha powder", category: "powder", baseUnit: "g", packQuantity: 1, packUnit: "lb" },
  { key: "chai-concentrate", name: "Chai concentrate", category: "tea", baseUnit: "ml", packQuantity: 32, packUnit: "fl_oz" },
  { key: "tea-bag", name: "Tea bags", category: "tea", baseUnit: "each", packQuantity: 1, packUnit: "case(100)" },
  { key: "filtered-water", name: "Filtered water", category: "other", baseUnit: "ml", packQuantity: 1, packUnit: "gal" },
  ...([8, 12, 16, 20] as const).map((size) => cup("hot", size)),
  ...([16, 20, 24] as const).map((size) => cup("cold", size)),
  { key: "lid-hot", name: "Hot cup lids", category: "packaging", baseUnit: "each", packQuantity: 1, packUnit: "case(1000)" },
  { key: "lid-cold", name: "Cold cup lids", category: "packaging", baseUnit: "each", packQuantity: 1, packUnit: "case(1000)" },
  { key: "sleeve", name: "Cup sleeves", category: "packaging", baseUnit: "each", packQuantity: 1, packUnit: "case(1000)" },
  { key: "straw", name: "Straws", category: "packaging", baseUnit: "each", packQuantity: 1, packUnit: "case(1000)" },
];

export const PANTRY_STARTERS_BY_KEY = new Map(PANTRY_STARTERS.map((item) => [item.key, item]));


/** Stored names are canonical defaults. Translate only an unchanged starter name;
 * an owner's rename always wins, in every locale. No UI components need changing. */
export function displayPantryStarterName(
  name: string, starterKey: string | null | undefined,
  translate: (key: string) => string,
): string {
  if (!starterKey) return name;
  const starter = PANTRY_STARTERS_BY_KEY.get(starterKey);
  return starter && name === starter.name ? translate(starterKey) : name;
}
