import { describe, expect, it } from "vitest";
import {
  firstUncoveredSalesDay,
  initialCardSalesShareBps,
  missingCoverageSaveOptions,
  validateRequiredFeeFields,
  isFeeFieldInvalid,
  prepareAdvancedRateDraft,
  selectedFeeCoverageForSalesDays,
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
