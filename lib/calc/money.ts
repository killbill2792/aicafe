import { formatCafeCurrency } from "@/lib/format/cafeCurrency";

/** Round only at the end of a calculation, half-up to the cent (docs/05-calculations.md). */
export function roundHalfUpToCent(cents: number): number {
  return Math.round(cents);
}

export function sumCents<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Display a money amount only in an explicitly supplied café currency.
 * Without one, display the amount without inventing a currency. Screens must
 * show the translated "currency not set" note alongside currency-less figures. */
export function formatCents(cents: number, locale = "en-US", currency?: string | null): string {
  return formatCafeCurrency(roundHalfUpToCent(cents), locale, currency).text;
}
