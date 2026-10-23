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

/**
 * The form may retain an advanced draft when the owner switches back to simple mode.
 * Hidden rules are not submitted, so they must never influence validation or required inputs.
 */
export function activeRateDrafts<T>(rules: readonly T[], advanced: boolean): T[] {
  return advanced ? [...rules] : rules.slice(0, 1);
}

/** Only the currently submitted rules may require a fallback ticket assumption. */
/** An average ticket is only needed for estimate days within the submitted plan's window. */
export function untrustedDaysFromEffectiveDate(
  untrustedFeeDates: readonly string[],
  effectiveFrom: string,
): number {
  if (!isRealIsoDay(effectiveFrom)) return 0;
  return untrustedFeeDates.filter((day) => day >= effectiveFrom).length;
}

export function requiresAverageTicket(
  activeRules: readonly { fixedFee: string }[],
  untrustedFeeDays: number,
  processedTransactionShare: string,
): boolean {
  return untrustedFeeDays > 0 &&
    Number(processedTransactionShare) > 0 &&
    activeRules.some((rule) => Number(rule.fixedFee) > 0);
}

/** Mirrors validateOwnerConfirmedProcessingFeePlan: mix totals matter only when their
 * associated share is positive (transaction mix further requires fixed fees). */
export function requiredRateMixErrors(
  rules: readonly { salesMix: string; transactionMix: string; fixedFee: string }[],
  salesShare: string,
  transactionShare: string,
): { salesMix: boolean; transactionMix: boolean } {
  const sum = (key: "salesMix" | "transactionMix") =>
    rules.reduce((total, rule) => total + Math.round(Number(rule[key]) * 100), 0);
  const hasFixedFees = rules.some((rule) => Number(rule.fixedFee) > 0);
  return {
    salesMix: Number(salesShare) > 0 && sum("salesMix") !== 10000,
    transactionMix: hasFixedFees && Number(transactionShare) > 0 && sum("transactionMix") !== 10000,
  };
}

/** A required simple-mode ticket input is visible without enabling advanced rules. */
export function showAverageTicketField(advanced: boolean, activeRules: readonly { fixedFee: string }[], untrustedFeeDays: number, transactionShare: string): boolean {
  return advanced || requiresAverageTicket(activeRules, untrustedFeeDays, transactionShare);
}

/** A POS connection or provider-attributed connected actual is evidence of a processor.
 * An uploaded/manual actual is not evidence of an additional card processor.
 */
export function knownProcessorCount(
  activeConnections: readonly { provider: string }[],
  selectedFacts: readonly { provider: string; source_type: string }[],
): number {
  const names = [
    ...activeConnections.map((item) => item.provider),
    ...selectedFacts
      .filter((fact) => fact.source_type === "connected_pos_actual")
      .map((fact) => fact.provider),
  ].map((name) => name.toLowerCase().trim())
    .filter((name) => name.length > 0 && name !== "csv" && name !== "demo");
  return new Set(names).size;
}

/** Real actuals never require an owner fallback, regardless of order-count coverage. */
export function untrustedEstimateDayCount(
  coverageDays: readonly FeeCoverageDay[],
  trustedOrderDates: ReadonlySet<string>,
): number {
  return coverageDays.filter((day) => day.status !== "actual" && !trustedOrderDates.has(day.date)).length;
}

/** The server schema accepts at most eight distinct rate rules. */
export function canAddRateRule(count: number): boolean {
  return count >= 0 && count < 8;
}
