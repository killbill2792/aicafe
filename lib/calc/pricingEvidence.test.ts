import { describe, expect, it } from "vitest";
import {
  analyzePriceChangeSalesResponse,
  compareNearbyMarketPrice,
  compareCostBasedPrice,
  type ItemSalesEvidenceDay,
  type MarketPriceObservation,
} from "./pricingEvidence";

function day(date: string, units: number, revenueCents: number, covered = true): ItemSalesEvidenceDay {
  return { date, units, revenueCents, covered };
}

describe("price-change sales response", () => {
  it("requires a real prior price change", () => {
    expect(analyzePriceChangeSalesResponse(null, [])).toEqual({ status: "no_change_history" });
    expect(analyzePriceChangeSalesResponse({
      changedOn: "2026-10-01", oldPriceCents: null, newPriceCents: 600,
      sourceType: "initial", sourceProvider: null,
    }, [])).toEqual({ status: "no_change_history" });
  });

  it("says not enough data instead of predicting demand", () => {
    const result = analyzePriceChangeSalesResponse({
      changedOn: "2026-10-01", oldPriceCents: 500, newPriceCents: 550,
      sourceType: "owner_manual", sourceProvider: "Owner",
    }, [
      day("2026-09-29", 12, 6_000),
      day("2026-09-30", 10, 5_000),
      day("2026-10-02", 9, 4_950),
      day("2026-10-03", 8, 4_400),
    ]);
    expect(result.status).toBe("not_enough_data");
  });

  it("reports observed units/day and revenue/day before vs after", () => {
    const sales: ItemSalesEvidenceDay[] = [];
    for (let d = 17; d <= 30; d += 1) sales.push(day(`2026-09-${String(d).padStart(2, "0")}`, 10, 5_000));
    for (let d = 2; d <= 15; d += 1) sales.push(day(`2026-10-${String(d).padStart(2, "0")}`, 8, 4_400));
    const result = analyzePriceChangeSalesResponse({
      changedOn: "2026-10-01", oldPriceCents: 500, newPriceCents: 550,
      sourceType: "owner_manual", sourceProvider: "Owner",
    }, sales);
    expect(result).toMatchObject({
      status: "ready",
      beforeCoveredDays: 14,
      afterCoveredDays: 14,
      beforeUnitsPerDay: 10,
      afterUnitsPerDay: 8,
      unitsPerDayChangePercent: -20,
      beforeRevenuePerDayCents: 5_000,
      afterRevenuePerDayCents: 4_400,
      revenuePerDayChangePercent: -12,
    });
  });

  it("includes covered zero-unit days for the item", () => {
    const sales: ItemSalesEvidenceDay[] = [];
    for (let d = 17; d <= 30; d += 1) sales.push(day(`2026-09-${String(d).padStart(2, "0")}`, 10, 5_000));
    for (let d = 2; d <= 15; d += 1) sales.push(day(`2026-10-${String(d).padStart(2, "0")}`, 0, 0));
    const result = analyzePriceChangeSalesResponse({
      changedOn: "2026-10-01", oldPriceCents: 500, newPriceCents: 600,
      sourceType: "connected_pos", sourceProvider: "square",
    }, sales);
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.unitsPerDayChangePercent).toBe(-100);
  });
});

describe("nearby market comparison", () => {
  const obs = (name: string, priceCents: number, distanceMeters: number | null, observedOn = "2026-10-01"): MarketPriceObservation => ({
    competitorName: name, priceCents, distanceMeters, observedOn, sourceLabel: "Public menu", sourceUrl: null,
  });

  it("requires three distinct recent nearby competitors", () => {
    expect(compareNearbyMarketPrice(650, [obs("A", 500, 500), obs("B", 550, 900)], "2026-10-08")).toEqual({
      status: "unavailable", verifiedNearbyCount: 2, minimumCompetitors: 3,
    });
  });

  it("does not call a remote or unsourced-distance observation nearby", () => {
    const result = compareNearbyMarketPrice(650, [
      obs("A", 500, null), obs("B", 550, 10_000), obs("C", 575, 900),
    ], "2026-10-08");
    expect(result.status).toBe("unavailable");
  });

  it("ignores stale competitor observations", () => {
    const result = compareNearbyMarketPrice(650, [
      obs("A", 500, 500, "2026-06-01"),
      obs("B", 550, 900, "2026-10-01"),
      obs("C", 575, 1_200, "2026-10-01"),
    ], "2026-10-08");
    expect(result).toEqual({ status: "unavailable", verifiedNearbyCount: 2, minimumCompetitors: 3 });
  });

  it("compares against the median of latest distinct nearby competitors", () => {
    const result = compareNearbyMarketPrice(650, [
      obs("A", 500, 500), obs("A", 450, 500, "2026-09-01"),
      obs("B", 550, 900), obs("C", 600, 1_200), obs("D", 575, 1_500),
    ], "2026-10-08");
    expect(result).toMatchObject({
      status: "ready",
      verifiedNearbyCount: 4,
      medianPriceCents: 563,
      differenceCents: 87,
      position: "above",
    });
  });
});


describe("cost-based price comparison", () => {
  it("does not call a missing benchmark market evidence", () => {
    expect(compareCostBasedPrice(650, null)).toEqual({ status: "unavailable" });
  });

  it("describes a price above the deterministic cost benchmark without calling it wrong", () => {
    expect(compareCostBasedPrice(650, 500)).toMatchObject({
      status: "ready",
      benchmarkPriceCents: 500,
      differenceCents: 150,
      differencePercent: 30,
      position: "above",
    });
  });

  it("uses a neutral range around the benchmark", () => {
    expect(compareCostBasedPrice(520, 500)).toMatchObject({ status: "ready", position: "within_range" });
  });
});
