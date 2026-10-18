/**
 * Transparent, read-only Menu estimate. These are per-drink ALLOCATIONS, not
 * observed item-level profit, and never become canonical payroll or prices.
 * All money inputs/outputs are integer cents.
 */
export type MenuPricePreviewInput = {
  priceCents: number;
  ingredientCents: number | null;
  monthlyRunningCents: number | null;
  monthlyPayrollCents: number | null;
  monthlyDrinks: number | null;
  monthlyPrepSeconds: number | null;
  itemPrepSeconds: number;
  processingFeeBps: number | null;
  targetOperatingMarginBps: number;
};

export type MenuPricePreviewResult = {
  status: "estimated" | "missing";
  missing: Array<"ingredients" | "bills" | "payroll" | "volume" | "fees">;
  ingredientContributionCents: number | null;
  billsPerDrinkCents: number | null;
  laborPerDrinkCents: number | null;
  cardFeePerDrinkCents: number | null;
  allocatedProfitCents: number | null;
  targetPriceCents: number | null;
  laborAllocation: "prep_time" | "equal_drinks" | null;
};

const safeMoney = (v: number | null): v is number =>
  v !== null && Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000_000;
const safeCount = (v: number | null): v is number =>
  v !== null && Number.isSafeInteger(v) && v > 0 && v <= 100_000_000;
const rounded = (n: number) => Math.round(n);

export function menuPricePreview(input: MenuPricePreviewInput): MenuPricePreviewResult {
  const missing: MenuPricePreviewResult["missing"] = [];
  if (!safeMoney(input.ingredientCents)) missing.push("ingredients");
  if (!safeMoney(input.monthlyRunningCents)) missing.push("bills");
  if (!safeMoney(input.monthlyPayrollCents)) missing.push("payroll");
  if (!safeCount(input.monthlyDrinks)) missing.push("volume");
  if (!Number.isSafeInteger(input.processingFeeBps) ||
      input.processingFeeBps === null || input.processingFeeBps < 0 ||
      input.processingFeeBps > 10000) missing.push("fees");

  const ingredientContributionCents = safeMoney(input.ingredientCents) &&
    Number.isSafeInteger(input.priceCents) && input.priceCents >= 0
      ? input.priceCents - input.ingredientCents : null;
  const billsPerDrinkCents = safeMoney(input.monthlyRunningCents) && safeCount(input.monthlyDrinks)
    ? rounded(input.monthlyRunningCents / input.monthlyDrinks) : null;

  // Prefer documented prep-time attribution. If historical item prep-time mix
  // is unavailable, use equal per-drink distribution, conspicuously estimated.
  const byPrepTime = input.monthlyPrepSeconds !== null &&
    Number.isSafeInteger(input.monthlyPrepSeconds) && input.monthlyPrepSeconds > 0 &&
    Number.isSafeInteger(input.itemPrepSeconds) && input.itemPrepSeconds > 0;
  const laborAllocation: MenuPricePreviewResult["laborAllocation"] =
    !safeMoney(input.monthlyPayrollCents) || !safeCount(input.monthlyDrinks)
      ? null : byPrepTime ? "prep_time" : "equal_drinks";
  const laborPerDrinkCents = laborAllocation === null ? null :
    rounded(laborAllocation === "prep_time"
      ? input.monthlyPayrollCents! * input.itemPrepSeconds / input.monthlyPrepSeconds!
      : input.monthlyPayrollCents! / input.monthlyDrinks!);
  const cardFeePerDrinkCents =
    Number.isSafeInteger(input.priceCents) && input.priceCents >= 0 &&
    input.processingFeeBps !== null && Number.isSafeInteger(input.processingFeeBps) &&
    input.processingFeeBps >= 0 && input.processingFeeBps <= 10000
      ? rounded(input.priceCents * input.processingFeeBps / 10000) : null;

  const complete = missing.length === 0 &&
    ingredientContributionCents !== null && billsPerDrinkCents !== null &&
    laborPerDrinkCents !== null && cardFeePerDrinkCents !== null;
  const allocatedProfitCents = complete
    ? ingredientContributionCents! - billsPerDrinkCents! -
      laborPerDrinkCents! - cardFeePerDrinkCents! : null;

  // Price needed to cover the same assigned non-price costs at the owner's
  // margin target. This is a conditional scenario, not a market recommendation.
  const margin = input.targetOperatingMarginBps;
  const denominator = 10000 - (input.processingFeeBps ?? 0) - margin;
  const targetPrice = complete && Number.isSafeInteger(margin) &&
    margin >= 0 && margin < 10000 && denominator > 0
      ? Math.ceil((input.ingredientCents! + billsPerDrinkCents! + laborPerDrinkCents!) *
        10000 / denominator) : null;
  const targetPriceCents = targetPrice !== null &&
    Number.isSafeInteger(targetPrice) && targetPrice >= 0 && targetPrice <= 100_000_000
      ? targetPrice : null;
  return { status: complete ? "estimated" : "missing", missing,
    ingredientContributionCents, billsPerDrinkCents,
    laborPerDrinkCents, cardFeePerDrinkCents, allocatedProfitCents,
    targetPriceCents, laborAllocation };
}
