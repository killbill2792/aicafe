/**
 * Monthly recurring costs distinguish "not provided" from "confirmed zero".
 * Blank/invalid/negative input => null. A literal 0 => 0 cents and is a valid saved bill.
 */
export function recurringCostAmountCentsFromInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}
