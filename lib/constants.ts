/** Fixed id for the shared "Demo café" business. Every new user gets membership on it
 * automatically (see supabase/migrations/20260926000009_new_user_demo_access.sql) and
 * scripts/db-reset.mjs reseeds its data. Never used for a real café. */
export const DEMO_BUSINESS_ID = "11111111-1111-1111-1111-111111111111";

/** Sentinel `employeeChoices` value meaning "this is a genuinely new person, not anyone already
 * on the roster" — used by `lib/actions/csvImport.ts`'s `resolveEmployeeIds` and
 * `components/uploads/LaborCsvImporter.tsx`'s review step. Lives here (not in the "use server"
 * csvImport.ts) because a "use server" file may only export async functions. */
export const NEW_EMPLOYEE = "__new__";

export const MENU_ITEM_CATEGORY_CODES = [
  "ESPRESSO_DRINK",
  "BREWED_COFFEE",
  "COLD_BREW",
  "TEA",
  "SPECIALTY_DRINK",
  "PASTRY",
  "FOOD",
  "RETAIL",
] as const;

export type MenuItemCategoryCode = (typeof MENU_ITEM_CATEGORY_CODES)[number];

export const EXPENSE_CATEGORY_CODES = [
  "rent",
  "utilities_power",
  "water",
  "internet",
  "insurance",
  "loan",
  "software",
  "supplies",
  "repairs",
  "ingredients",
  "other",
] as const;

export type ExpenseCategoryCode = (typeof EXPENSE_CATEGORY_CODES)[number];

/** Default cost-recovery bucket order (docs/05-calculations.md "Cost recovery"). */
export const DEFAULT_RECOVERY_ORDER: ExpenseCategoryCode[] = [
  "rent",
  "utilities_power",
  "water",
  "internet",
  "insurance",
  "loan",
  "software",
  "supplies",
  "repairs",
  "other",
];

/** Every category that counts toward "running costs" (everything except ingredients). */
export const RUNNING_COST_CODES: ExpenseCategoryCode[] = [...DEFAULT_RECOVERY_ORDER];
