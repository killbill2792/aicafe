/** Fixed id for the shared "Demo café" business. Every new user gets membership on it
 * automatically (see supabase/migrations/20260926000009_new_user_demo_access.sql) and
 * scripts/db-reset.mjs reseeds its data. Never used for a real café. */
export const DEMO_BUSINESS_ID = "11111111-1111-1111-1111-111111111111";

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
