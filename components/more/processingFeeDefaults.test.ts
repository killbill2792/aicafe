import { describe, expect, it } from "vitest";
import {
  firstUncoveredSalesDay,
  initialCardSalesShareBps,
  missingCoverageSaveOptions,
  validateRequiredFeeFields,
  isFeeFieldInvalid,
  prepareAdvancedRateDraft,
  selectedFeeCoverageForSalesDays,
  isRealIsoDay,
  activeRateDrafts,
  knownProcessorCount,
  untrustedEstimateDayCount,
  requiresAverageTicket,
  showAverageTicketField,
  untrustedDaysFromEffectiveDate,
  requiredRateMixErrors,
} from "./processingFeeDefaults";

describe("processing fee redesign defaults", () => {
  const days = [
    { date: "2026-10-22", status: "missing" as const },
    { date: "2026-08-07", status: "estimated" as const },
    { date: "2026-07-27", status: "missing" as const },
    { date: "2026-09-03", status: "actual" as const },
  ];

  it("defaults to the earliest uncovered sales day, not today", () => {
    expect(firstUncoveredSalesDay(days, "2026-10-23")).toBe("2026-07-27");
  });

  it("defaults to today when every sales day has actual or estimated coverage", () => {
    expect(firstUncoveredSalesDay(days.filter((day) => day.status !== "missing"), "2026-10-23")).toBe("2026-10-23");
  });

  it("defaults card sales to 100% only for exactly one processor", () => {
    expect(initialCardSalesShareBps(null, 1)).toBe(10_000);
    expect(initialCardSalesShareBps(null, 0)).toBeNull();
    expect(initialCardSalesShareBps(null, 2)).toBeNull();
    expect(initialCardSalesShareBps(8_000, 1)).toBe(8_000);
  });

  it("one-tap fix uses the first missing date, not the edited effective date", () => {
    expect(missingCoverageSaveOptions(days, "2026-10-23")).toEqual({
      coverMissing: true,
      effectiveFrom: "2026-07-27",
    });
  });
  it("treats missing selected facts as uncovered even if rollup status is stale", () => {
    const rows = [
      { business_date: "2026-10-20", net_sales_cents: 30000, card_fees_status: "estimated" },
      { business_date: "2026-10-21", net_sales_cents: 20000, card_fees_status: "actual" },
      { business_date: "2026-10-22", net_sales_cents: 0, card_fees_status: "missing" },
    ];
    expect(selectedFeeCoverageForSalesDays(rows, [{ business_date: "2026-10-21", status: "actual" }])).toEqual([
      { date: "2026-10-21", status: "actual" },
      { date: "2026-10-20", status: "missing" },
    ]);
  });

  it("returns field-specific messages for empty and invalid required inputs", () => {
    const messages = {
      requiredProcessor: "Choose your processor",
      requiredEffectiveDate: "Choose a date",
      requiredCardShare: "Enter card sales",
      requiredRate: "Enter percentage",
      requiredRule: "Enter fee",
    };
    const errors = validateRequiredFeeFields({
      processorLabel: "", effectiveFrom: "", cardSalesShare: "",
      percentageRate: "60", fixedFee: "-1", advanced: false, coverMissing: false,
    }, messages);
    expect(Object.keys(errors).sort()).toEqual([
      "cardShare", "effectiveFrom", "fixedFee", "percentageRate", "processor",
    ]);
    expect(errors.cardShare).toBe(messages.requiredCardShare);
    expect(isFeeFieldInvalid(errors, "cardShare")).toBe(true);
    expect(isFeeFieldInvalid(errors, "averageTicket")).toBe(false);
  });

  it("preserves a valid simple fixed-fee rate when revealing advanced average-ticket details", () => {
    const original = [{ id: "r1", label: "", percentageRate: "2.6", fixedFee: "0.15", salesMix: "100", transactionMix: "100" }];
    const revealed = prepareAdvancedRateDraft(original, "", "100", "Standard rate");
    expect(revealed.transactionShare).toBe("100");
    expect(revealed.rules).toEqual([{ ...original[0], label: "Standard rate" }]);
    expect(original[0].label).toBe(""); // no mutation
  });

  it("does not overwrite existing advanced rule names or transaction shares", () => {
    const original = [{ id: "r1", label: "Online", percentageRate: "3", fixedFee: "", salesMix: "100", transactionMix: "100" }];
    const revealed = prepareAdvancedRateDraft(original, "75", "100", "Standard rate");
    expect(revealed.transactionShare).toBe("75");
    expect(revealed.rules).toEqual(original);
  });

  it("rejects nonexistent dates rather than silently rolling them into March", () => {
    expect(isRealIsoDay("2026-02-28")).toBe(true);
    expect(isRealIsoDay("2026-02-30")).toBe(false);
    expect(isRealIsoDay("2024-02-29")).toBe(true);
    expect(isRealIsoDay("2025-02-29")).toBe(false);
  });

  it("ignores retained hidden advanced fixed fees when submitting simple mode", () => {
    const rules = [
      { id: "first", label: "Rate", percentageRate: "2.6", fixedFee: "0", salesMix: "100", transactionMix: "100" },
      { id: "hidden", label: "Special", percentageRate: "1", fixedFee: "0.30", salesMix: "0", transactionMix: "0" },
    ];
    expect(activeRateDrafts(rules, false)).toEqual([rules[0]]);
    expect(activeRateDrafts(rules, false).some((rule) => Number(rule.fixedFee) > 0)).toBe(false);
    expect(activeRateDrafts(rules, true)).toHaveLength(2);
    expect(rules).toHaveLength(2); // preserve advanced draft for later editing
  });

  it("counts connected processors but does not double-count manual uploads or duplicate connections", () => {
    const active = [{ provider: "Toast" }, { provider: "toast" }];
    const facts = [
      { provider: "manual", source_type: "manual_actual" },
      { provider: "toast", source_type: "connected_pos_actual" },
    ];
    expect(knownProcessorCount(active, facts)).toBe(1);
    expect(knownProcessorCount([], facts)).toBe(1);
    expect(knownProcessorCount([], [{ provider: "manual", source_type: "manual_actual" }])).toBe(0);
    expect(knownProcessorCount([{ provider: "toast" }, { provider: "square" }], facts)).toBe(2);
  });

  it("requires average ticket only for non-actual days missing trusted order counts", () => {
    const days = [
      { date: "2026-10-01", status: "actual" as const },
      { date: "2026-10-02", status: "actual" as const },
      { date: "2026-10-03", status: "missing" as const },
      { date: "2026-10-04", status: "estimated" as const },
    ];
    expect(untrustedEstimateDayCount(days, new Set(["2026-10-03", "2026-10-04"]))).toBe(0);
    expect(untrustedEstimateDayCount(days, new Set(["2026-10-03"]))).toBe(1);
    expect(untrustedEstimateDayCount(days, new Set())).toBe(2);
  });

  it("uses the exact same active-rule ticket requirement in UI and save", () => {
    const allRules = [{ fixedFee: "0" }, { fixedFee: "0.25" }];
    expect(requiresAverageTicket(activeRateDrafts(allRules, false), 3, "100")).toBe(false);
    expect(requiresAverageTicket(activeRateDrafts(allRules, true), 3, "100")).toBe(true);
    expect(requiresAverageTicket(activeRateDrafts(allRules, true), 0, "100")).toBe(false);
  });

  it("reveals required ticket in simple mode without changing submitted rules", () => {
    const all = [
      { id: "standard", fixedFee: "0.15" },
      { id: "hidden", fixedFee: "0.30" },
    ];
    const simple = activeRateDrafts(all, false);
    expect(showAverageTicketField(false, simple, 2, "100")).toBe(true);
    expect(requiresAverageTicket(simple, 2, "100")).toBe(true);
    expect(simple).toEqual([all[0]]);
    // Entering a ticket cannot make the hidden second rule part of the submission.
    expect(activeRateDrafts(all, false)).toEqual([all[0]]);
    expect(showAverageTicketField(true, activeRateDrafts(all, true), 0)).toBe(true);
  });

  it("keeps a hidden fixed-fee-only rule entirely out of a simple-mode ticket requirement", () => {
    const all = [{ fixedFee: "0" }, { fixedFee: "0.30" }];
    expect(showAverageTicketField(false, activeRateDrafts(all, false), 4)).toBe(false);
  });

  it("does not require a ticket for dates before the selected plan, but one-tap backdating does", () => {
    const dates = ["2026-08-01", "2026-08-13", "2026-10-12"];
    expect(untrustedDaysFromEffectiveDate(dates, "2026-10-23")).toBe(0);
    expect(untrustedDaysFromEffectiveDate(dates, "2026-10-10")).toBe(1);
    expect(untrustedDaysFromEffectiveDate(dates, "2026-08-01")).toBe(3);
    expect(untrustedDaysFromEffectiveDate(dates, "invalid")).toBe(0);
  });

  it("does not require an average ticket for 0% processed transactions", () => {
    const rules = [{ fixedFee: "0.35" }];
    expect(requiresAverageTicket(rules, 4, "0")).toBe(false);
    expect(requiresAverageTicket(rules, 4, "100")).toBe(true);
    expect(showAverageTicketField(false, rules, 4, "0")).toBe(false);
  });

  it("uses the same conditional mix totals as the server validator", () => {
    const single = [{ salesMix: "0", transactionMix: "0", fixedFee: "0" }];
    expect(requiredRateMixErrors(single, "0", "0")).toEqual({ salesMix: false, transactionMix: false });
    expect(requiredRateMixErrors(single, "100", "0")).toEqual({ salesMix: true, transactionMix: false });
    expect(requiredRateMixErrors(single, "0", "100")).toEqual({ salesMix: false, transactionMix: false });
    expect(requiredRateMixErrors([{ ...single[0], fixedFee: "0.2" }], "0", "100")).toEqual({ salesMix: false, transactionMix: true });
    const mixed = [
      { salesMix: "60", transactionMix: "40", fixedFee: "0.2" },
      { salesMix: "40", transactionMix: "60", fixedFee: "0.1" },
    ];
    expect(requiredRateMixErrors(mixed, "100", "100")).toEqual({ salesMix: false, transactionMix: false });
  });

  it("one-tap bypasses a manually empty date but still requires fee inputs", () => {
    const messages = {
      requiredProcessor: "Processor", requiredEffectiveDate: "Date",
      requiredCardShare: "Card share", requiredRate: "Rate", requiredRule: "Fee",
    };
    expect(validateRequiredFeeFields({
      processorLabel: "Toast", effectiveFrom: "", cardSalesShare: "100",
      percentageRate: "2.6", fixedFee: "0.15", advanced: false, coverMissing: true,
    }, messages)).toEqual({});
  });
});
