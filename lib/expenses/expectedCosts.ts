import type { ExpenseCategoryCode } from "@/lib/constants";
import type { RunningCostLine } from "@/lib/data/types";

export type CostExpectationEvidence = {
  hasActiveRecurring: boolean;
  hadActualPreviousMonth: boolean;
  explicitlyExpected?: boolean;
};

const REGULAR_MONTHLY_CATEGORIES = new Set<ExpenseCategoryCode>(["rent", "utilities_power", "water", "internet", "insurance", "loan", "software", "supplies"]);

export function isExpectedCostCategory(category: ExpenseCategoryCode, evidence: CostExpectationEvidence): boolean {
  return evidence.hasActiveRecurring || evidence.explicitlyExpected === true ||
    (REGULAR_MONTHLY_CATEGORIES.has(category) && evidence.hadActualPreviousMonth);
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
