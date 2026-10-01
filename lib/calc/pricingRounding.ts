import type { RoundingRule } from "./types";

export function applyRounding(rawCents: number, rule: RoundingRule): number {
  if (rawCents <= 0 || rule.incrementCents <= 0) return 0;
  const units = rawCents / rule.incrementCents;
  // Math.round makes exact half-increment ties round up.
  const rounded = rule.mode === "up" ? Math.ceil(units) : rule.mode === "down" ? Math.floor(units) : Math.round(units);
  return rounded * rule.incrementCents;
}
