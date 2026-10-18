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
  /** Trusted actual fee sums; use them for exact arithmetic, not rounded bps. */
  processingFeeNumeratorCents?: number | null;
  processingFeeDenominatorCents?: number | null;
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
  const numerator=input.processingFeeNumeratorCents;
  const denominatorCents=input.processingFeeDenominatorCents;
  const exactRateAvailable=typeof numerator==="number"&&
    typeof denominatorCents==="number"&&
    Number.isSafeInteger(numerator)&&Number.isSafeInteger(denominatorCents)&&
    denominatorCents>0&&numerator>=0&&numerator<=denominatorCents;
  const validBps=input.processingFeeBps!==null&&
    Number.isSafeInteger(input.processingFeeBps)&&
    input.processingFeeBps>=0&&input.processingFeeBps<=10000;
  const feeRate=exactRateAvailable?numerator/denominatorCents:
    validBps?input.processingFeeBps!/10000:null;
  if(feeRate===null) missing.push("fees");

  const ingredientContributionCents = safeMoney(input.ingredientCents) &&
    Number.isSafeInteger(input.priceCents) && input.priceCents >= 0
      ? input.priceCents - input.ingredientCents : null;
  // Preserve sub-cent precision until the final profit/target computation.
  // Individual allocations are rounded only for their display fields.
  const rawBillsPerDrink = safeMoney(input.monthlyRunningCents) && safeCount(input.monthlyDrinks)
    ? input.monthlyRunningCents / input.monthlyDrinks : null;
  const billsPerDrinkCents = rawBillsPerDrink===null?null:rounded(rawBillsPerDrink);

  // Prefer documented prep-time attribution. If historical item prep-time mix
  // is unavailable, use equal per-drink distribution, conspicuously estimated.
  const byPrepTime = input.monthlyPrepSeconds !== null &&
    Number.isSafeInteger(input.monthlyPrepSeconds) && input.monthlyPrepSeconds > 0 &&
    Number.isSafeInteger(input.itemPrepSeconds) && input.itemPrepSeconds > 0;
  const laborAllocation: MenuPricePreviewResult["laborAllocation"] =
    !safeMoney(input.monthlyPayrollCents) || !safeCount(input.monthlyDrinks)
      ? null : byPrepTime ? "prep_time" : "equal_drinks";
  const rawLaborPerDrink = laborAllocation === null ? null :
    laborAllocation === "prep_time"
      ? input.monthlyPayrollCents! * input.itemPrepSeconds / input.monthlyPrepSeconds!
      : input.monthlyPayrollCents! / input.monthlyDrinks!;
  const laborPerDrinkCents = rawLaborPerDrink===null?null:rounded(rawLaborPerDrink);
  const rawCardFeePerDrink =
    Number.isSafeInteger(input.priceCents) && input.priceCents >= 0 &&
    feeRate!==null ? input.priceCents * feeRate : null;
  const cardFeePerDrinkCents=rawCardFeePerDrink===null?null:rounded(rawCardFeePerDrink);

  const complete = missing.length === 0 &&
    ingredientContributionCents !== null && billsPerDrinkCents !== null &&
    laborPerDrinkCents !== null && cardFeePerDrinkCents !== null;
  const allocatedProfitCents = complete
    ? rounded(ingredientContributionCents! - rawBillsPerDrink! -
      rawLaborPerDrink! - rawCardFeePerDrink!) : null;

  // Price needed to cover the same assigned non-price costs at the owner's
  // margin target. This is a conditional scenario, not a market recommendation.
  const margin = input.targetOperatingMarginBps;
  const denominator = 1 - (feeRate ?? 0) - margin / 10000;
  const targetPrice = complete && Number.isSafeInteger(margin) &&
    margin >= 0 && margin < 10000 && denominator > 0
      ? Math.ceil((input.ingredientCents! + rawBillsPerDrink! + rawLaborPerDrink!) /
        denominator) : null;
  const targetPriceCents = targetPrice !== null &&
    Number.isSafeInteger(targetPrice) && targetPrice >= 0 && targetPrice <= 100_000_000
      ? targetPrice : null;
  return { status: complete ? "estimated" : "missing", missing,
    ingredientContributionCents, billsPerDrinkCents,
    laborPerDrinkCents, cardFeePerDrinkCents, allocatedProfitCents,
    targetPriceCents, laborAllocation };
}
