import type { ExpenseCategoryCode } from "@/lib/constants";
import type { RunningCostLine } from "@/lib/data/types";

export type CostExpectationEvidence = {
  hasActiveRecurring: boolean;
  hasPriorActual: boolean;
  explicitlyExpected?: boolean;
};

export function isExpectedCostCategory(evidence: CostExpectationEvidence): boolean {
  return evidence.hasActiveRecurring || evidence.hasPriorActual || evidence.explicitlyExpected === true;
}

export function expectedMissingCostLines(lines: RunningCostLine[]): RunningCostLine[] {
  return lines.filter((line) => line.isMissing && line.isExpected !== false);
}

const BILL_CATEGORIES = new Set<ExpenseCategoryCode>(["rent", "utilities_power", "water", "internet", "insurance", "loan", "software", "other"]);

export function isBillCategory(category: ExpenseCategoryCode): boolean { return BILL_CATEGORIES.has(category); }

export function missingCostDestination(category: ExpenseCategoryCode): string {
  return isBillCategory(category)
    ? `/more/bills?category=${encodeURIComponent(category)}`
    : `/add-cost/type?category=${encodeURIComponent(category)}`;
}
