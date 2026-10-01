import { type MenuItemCategoryCode } from "@/lib/constants";

const KEYWORD_RULES: { pattern: RegExp; category: MenuItemCategoryCode }[] = [
  { pattern: /cold brew|nitro/i, category: "COLD_BREW" },
  { pattern: /latte|espresso|cappuccino|macchiato|americano|cortado|flat white|mocha/i, category: "ESPRESSO_DRINK" },
  { pattern: /drip|brewed|pour.?over|french press/i, category: "BREWED_COFFEE" },
  { pattern: /tea|chai|matcha/i, category: "TEA" },
  { pattern: /smoothie|lemonade|refresher|italian soda/i, category: "SPECIALTY_DRINK" },
  { pattern: /croissant|muffin|scone|bagel|pastry|cookie|cake/i, category: "PASTRY" },
  { pattern: /sandwich|wrap|salad|bowl|toast/i, category: "FOOD" },
  { pattern: /bag of beans|merch|mug|tumbler/i, category: "RETAIL" },
];

const GROUP_DEFAULTS: Record<string, MenuItemCategoryCode> = {
  food: "FOOD",
  bakery: "PASTRY",
  retail: "RETAIL",
  drinks: "ESPRESSO_DRINK",
  coffee: "ESPRESSO_DRINK",
  tea: "TEA",
};

/** A best-guess default `category` for a newly-created item, from its name and (if given) menu
 * group — never asserted as confirmed, just a sane starting point the owner can change any time
 * from the detail page's edit section. `category` (internal analytics code) stays a separate
 * concept from `menuGroup` (owner-facing section) even when this inference uses both as input. */
export function inferMenuItemCategory(name: string, menuGroup?: string | null): MenuItemCategoryCode {
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(name)) return rule.category;
  }
  const groupDefault = menuGroup ? GROUP_DEFAULTS[menuGroup.trim().toLowerCase()] : undefined;
  return groupDefault ?? "ESPRESSO_DRINK";
}
