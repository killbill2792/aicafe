import { profitTone, type ProfitTone } from "./profitTone";

export type OwnerProfitDisplayState =
  /** Zero actual days of sales data for this period — nothing real to report yet. Showing
   * "$0 sales − a full period's accrued bills" as a confirmed number would present a figure
   * nobody has actually seen happen; the UI must say the result isn't available, not color a
   * specific dollar loss. */
  | { kind: "unavailable" }
  /** Some but not all of the period's calendar days have a sales rollup — a real number, but not
   * a finished period result. Still shown (it's useful context), just visibly flagged as partial. */
  | { kind: "partial"; ownerProfitCents: number; tone: ProfitTone }
  /** Every calendar day in the period has a sales rollup — a complete, confirmed result. */
  | { kind: "complete"; ownerProfitCents: number; tone: ProfitTone };

/**
 * How an "Owner profit" figure should be presented for a period, given how much of that period's
 * calendar range actually has a sales rollup (`periodCoverage`). The underlying math never
 * changes — bills accrue deterministically whether or not sales were uploaded — this only decides
 * whether the UI may present that math as a finished, confirmed result.
 */
export function ownerProfitDisplayState(
  ownerProfitCents: number,
  coverage: { actualDays: number; expectedDays: number },
): OwnerProfitDisplayState {
  if (coverage.actualDays === 0) return { kind: "unavailable" };
  if (coverage.actualDays < coverage.expectedDays) return { kind: "partial", ownerProfitCents, tone: profitTone(ownerProfitCents) };
  return { kind: "complete", ownerProfitCents, tone: profitTone(ownerProfitCents) };
}
