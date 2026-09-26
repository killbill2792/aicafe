/** Fixture B: per-drink staff time (docs/05-calculations.md). One day, loaded staff cost $300.00. */
export const FIXTURE_B = {
  loadedStaffCostCents: 30_000,
  latte: { prepSeconds: 90, quantity: 100, priceCents: 525, ingredientsCents: 95 },
  drip: { prepSeconds: 30, quantity: 100, ingredientsCents: 0 },
  effectiveFeeRate: 0.029167,
};
