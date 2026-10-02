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

/** Width (0–100) for a "from sales to pocket" flow-bar segment — always based on the magnitude
 * of `valueCents`, never its sign. A negative owner profit must still draw a visible bar (in red,
 * via `profitTone` separately) sized to how big the loss is relative to sales; using the signed
 * value here would clamp to 0 and render an invisible bar for every loss. */
export function flowBarWidthPct(valueCents: number, salesCents: number): number {
  if (salesCents <= 0) return 0;
  return Math.max(0, Math.min(100, (Math.abs(valueCents) / salesCents) * 100));
}
