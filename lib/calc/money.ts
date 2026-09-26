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

/** Formats integer cents as a dollar string, e.g. 520048 -> "$5,200.48". Display-only. */
export function formatCents(cents: number, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(roundHalfUpToCent(cents) / 100);
}
