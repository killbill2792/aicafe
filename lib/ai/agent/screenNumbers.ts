/** Official metric identities, NOT tool authority. An independently derived
 * calculation is not automatically the official screen value. Official parity
 * depends on the shared definition, period, inputs and assumptions. */
export const SCREEN_NUMBER_IDS=["profit","labor_cost","card_fees","break_even","item_cost"] as const;
export type ScreenNumber=(typeof SCREEN_NUMBER_IDS)[number];
