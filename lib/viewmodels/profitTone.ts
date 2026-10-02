/** The one rule for how a profit/loss number should read visually, wherever it appears on
 * Money: positive → green ("good"), negative → red/warning, exactly zero → neutral. A single
 * function so every place that shows owner profit can't disagree about which color a given
 * number gets. */
export type ProfitTone = "good" | "warn" | "neutral";

export function profitTone(cents: number): ProfitTone {
  if (cents > 0) return "good";
  if (cents < 0) return "warn";
  return "neutral";
}

export function profitToneTextClass(tone: ProfitTone): string {
  return tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : "text-ink";
}
