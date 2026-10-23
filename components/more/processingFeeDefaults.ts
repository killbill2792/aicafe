/** Pure helpers shared by server coverage setup and the client fee form. */
export type FeeCoverageDay = {
  date: string;
  status: "actual" | "estimated" | "missing";
};

export function firstUncoveredSalesDay(days: FeeCoverageDay[], today: string): string {
  return days
    .filter((day) => day.status === "missing")
    .map((day) => day.date)
    .sort()[0] ?? today;
}

/** Never assume all sales are card sales unless there is exactly one known processor. */
export function initialCardSalesShareBps(
  savedShareBps: number | null,
  processorCount: number,
): number | null {
  return savedShareBps ?? (processorCount === 1 ? 10_000 : null);
}

/** The button always persists the user's current rate with the missing-history start date. */
export function missingCoverageSaveOptions(days: FeeCoverageDay[], today: string) {
  return { coverMissing: true as const, effectiveFrom: firstUncoveredSalesDay(days, today) };
}

export function isRealIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T12:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Client-side field validation; error keys also drive aria-invalid and focus. */
export function validateRequiredFeeFields(
  values: {
    processorLabel: string;
    effectiveFrom: string;
    cardSalesShare: string;
    percentageRate: string;
    fixedFee: string;
    advanced: boolean;
    coverMissing: boolean;
  },
  messages: {
    requiredProcessor: string;
    requiredEffectiveDate: string;
    requiredCardShare: string;
    requiredRate: string;
    requiredRule: string;
  },
): Record<string, string> {
  const errors: Record<string, string> = {};
  const percent = (value: string) => {
    const number = Number(value);
    return value.trim() !== "" && Number.isFinite(number) && number >= 0 && number <= 100;
  };
  if (!values.processorLabel.trim()) errors.processor = messages.requiredProcessor;
  if (!values.coverMissing && !isRealIsoDay(values.effectiveFrom)) {
    errors.effectiveFrom = messages.requiredEffectiveDate;
  }
  if (!percent(values.cardSalesShare)) errors.cardShare = messages.requiredCardShare;
  if (!values.advanced && (!percent(values.percentageRate) || Number(values.percentageRate) > 50)) {
    errors.percentageRate = messages.requiredRate;
  }
  if (!values.advanced && values.fixedFee.trim() && (!percent(values.fixedFee) || Number(values.fixedFee) > 50)) {
    errors.fixedFee = messages.requiredRule;
  }
  return errors;
}

export function isFeeFieldInvalid(errors: Record<string, string>, key: string): boolean {
  return Boolean(errors[key]);
}


/**
 * Opening advanced options must not invalidate an otherwise complete simple rate.
 * Keep the existing rate amounts/mixes; fill only defaults hidden by simple mode.
 */
export function prepareAdvancedRateDraft<T extends { label: string }>(
  rules: T[],
  transactionShare: string,
  cardShare: string,
  standardRate: string,
): { rules: T[]; transactionShare: string } {
  return {
    rules: rules.map((rule, index) => index === 0 && !rule.label.trim()
      ? { ...rule, label: standardRate }
      : rule),
    transactionShare: transactionShare.trim() ? transactionShare : cardShare,
  };
}


/** The selected fee fact is authoritative; a stale rollup flag is not coverage. */
export function selectedFeeCoverageForSalesDays(
  rows: ReadonlyArray<{ business_date: string; net_sales_cents: number }>,
  facts: ReadonlyArray<{ business_date: string; status: string }>,
): FeeCoverageDay[] {
  const selected = new Map(facts
    .filter((fact) => fact.status === "actual" || fact.status === "estimated")
    .map((fact) => [fact.business_date, fact.status as FeeCoverageDay["status"]]));
  return rows
    .filter((row) => Number(row.net_sales_cents) > 0)
    .map((row) => ({
      date: row.business_date,
      status: selected.get(row.business_date) ?? "missing",
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}
