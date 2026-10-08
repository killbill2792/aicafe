export type MenuPriceChange = {
  changedOn: string;
  oldPriceCents: number | null;
  newPriceCents: number;
  sourceType: "initial" | "owner_manual" | "connected_pos" | "imported";
  sourceProvider: string | null;
};

export type ItemSalesEvidenceDay = {
  date: string;
  covered: boolean;
  units: number;
  revenueCents: number;
};

export type PriceChangeSalesResponse =
  | { status: "no_change_history" }
  | {
      status: "not_enough_data";
      change: MenuPriceChange;
      beforeCoveredDays: number;
      afterCoveredDays: number;
      beforeUnits: number;
      minimumCoveredDays: number;
      minimumBeforeUnits: number;
    }
  | {
      status: "ready";
      change: MenuPriceChange;
      beforeCoveredDays: number;
      afterCoveredDays: number;
      beforeUnitsPerDay: number;
      afterUnitsPerDay: number;
      unitsPerDayChangePercent: number;
      beforeRevenuePerDayCents: number;
      afterRevenuePerDayCents: number;
      revenuePerDayChangePercent: number;
    };

export type MarketPriceObservation = {
  competitorName: string;
  priceCents: number;
  observedOn: string;
  distanceMeters: number | null;
  sourceLabel: string;
  sourceUrl: string | null;
};

export type NearbyMarketComparison =
  | {
      status: "unavailable";
      verifiedNearbyCount: number;
      minimumCompetitors: number;
    }
  | {
      status: "ready";
      verifiedNearbyCount: number;
      medianPriceCents: number;
      differenceCents: number;
      differencePercent: number;
      position: "above" | "below" | "within_range";
      observations: MarketPriceObservation[];
    };

const DAY_MS = 86_400_000;
export const PRICE_RESPONSE_WINDOW_DAYS = 14;
export const PRICE_RESPONSE_MIN_COVERED_DAYS = 7;
export const PRICE_RESPONSE_MIN_BEFORE_UNITS = 20;
export const MARKET_MAX_DISTANCE_METERS = 8_000;
export const MARKET_MAX_AGE_DAYS = 90;
export const MARKET_MIN_COMPETITORS = 3;

function utcDay(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function dateAtOffset(date: string, days: number): string {
  return new Date(utcDay(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function percentChange(before: number, after: number): number {
  if (before === 0) return 0;
  return ((after - before) / before) * 100;
}

export function analyzePriceChangeSalesResponse(
  change: MenuPriceChange | null,
  salesDays: ItemSalesEvidenceDay[],
  options: {
    windowDays?: number;
    minimumCoveredDays?: number;
    minimumBeforeUnits?: number;
  } = {},
): PriceChangeSalesResponse {
  if (
    !change ||
    change.oldPriceCents === null ||
    change.oldPriceCents <= 0 ||
    change.newPriceCents <= 0 ||
    change.oldPriceCents === change.newPriceCents
  ) {
    return { status: "no_change_history" };
  }

  const windowDays = options.windowDays ?? PRICE_RESPONSE_WINDOW_DAYS;
  const minimumCoveredDays = options.minimumCoveredDays ?? PRICE_RESPONSE_MIN_COVERED_DAYS;
  const minimumBeforeUnits = options.minimumBeforeUnits ?? PRICE_RESPONSE_MIN_BEFORE_UNITS;
  const beforeStart = dateAtOffset(change.changedOn, -windowDays);
  const beforeEnd = dateAtOffset(change.changedOn, -1);
  const afterStart = dateAtOffset(change.changedOn, 1);
  const afterEnd = dateAtOffset(change.changedOn, windowDays);

  const before = salesDays.filter(
    (day) => day.covered && day.date >= beforeStart && day.date <= beforeEnd,
  );
  const after = salesDays.filter(
    (day) => day.covered && day.date >= afterStart && day.date <= afterEnd,
  );
  const beforeUnits = before.reduce((sum, day) => sum + day.units, 0);

  if (
    before.length < minimumCoveredDays ||
    after.length < minimumCoveredDays ||
    beforeUnits < minimumBeforeUnits
  ) {
    return {
      status: "not_enough_data",
      change,
      beforeCoveredDays: before.length,
      afterCoveredDays: after.length,
      beforeUnits,
      minimumCoveredDays,
      minimumBeforeUnits,
    };
  }

  const afterUnits = after.reduce((sum, day) => sum + day.units, 0);
  const beforeRevenue = before.reduce((sum, day) => sum + day.revenueCents, 0);
  const afterRevenue = after.reduce((sum, day) => sum + day.revenueCents, 0);
  const beforeUnitsPerDay = beforeUnits / before.length;
  const afterUnitsPerDay = afterUnits / after.length;
  const beforeRevenuePerDayCents = Math.round(beforeRevenue / before.length);
  const afterRevenuePerDayCents = Math.round(afterRevenue / after.length);

  return {
    status: "ready",
    change,
    beforeCoveredDays: before.length,
    afterCoveredDays: after.length,
    beforeUnitsPerDay,
    afterUnitsPerDay,
    unitsPerDayChangePercent: percentChange(beforeUnitsPerDay, afterUnitsPerDay),
    beforeRevenuePerDayCents,
    afterRevenuePerDayCents,
    revenuePerDayChangePercent: percentChange(beforeRevenuePerDayCents, afterRevenuePerDayCents),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function compareNearbyMarketPrice(
  currentPriceCents: number,
  observations: MarketPriceObservation[],
  asOfDate: string,
  options: {
    maxDistanceMeters?: number;
    maxAgeDays?: number;
    minimumCompetitors?: number;
    withinRangePercent?: number;
  } = {},
): NearbyMarketComparison {
  const maxDistanceMeters = options.maxDistanceMeters ?? MARKET_MAX_DISTANCE_METERS;
  const maxAgeDays = options.maxAgeDays ?? MARKET_MAX_AGE_DAYS;
  const minimumCompetitors = options.minimumCompetitors ?? MARKET_MIN_COMPETITORS;
  const withinRangePercent = options.withinRangePercent ?? 5;
  const oldestAllowed = dateAtOffset(asOfDate, -maxAgeDays);

  const latestByCompetitor = new Map<string, MarketPriceObservation>();
  for (const observation of observations) {
    if (
      observation.priceCents <= 0 ||
      observation.observedOn < oldestAllowed ||
      observation.observedOn > asOfDate ||
      observation.distanceMeters === null ||
      observation.distanceMeters > maxDistanceMeters
    ) {
      continue;
    }
    const key = observation.competitorName.trim().toLowerCase();
    const prior = latestByCompetitor.get(key);
    if (!prior || observation.observedOn > prior.observedOn) {
      latestByCompetitor.set(key, observation);
    }
  }

  const verified = [...latestByCompetitor.values()];
  if (verified.length < minimumCompetitors || currentPriceCents <= 0) {
    return { status: "unavailable", verifiedNearbyCount: verified.length, minimumCompetitors };
  }

  const medianPriceCents = median(verified.map((observation) => observation.priceCents));
  const differenceCents = currentPriceCents - medianPriceCents;
  const differencePercent = medianPriceCents === 0 ? 0 : (differenceCents / medianPriceCents) * 100;
  const position =
    differencePercent > withinRangePercent
      ? "above"
      : differencePercent < -withinRangePercent
        ? "below"
        : "within_range";

  return {
    status: "ready",
    verifiedNearbyCount: verified.length,
    medianPriceCents,
    differenceCents,
    differencePercent,
    position,
    observations: verified.sort((a, b) => a.distanceMeters! - b.distanceMeters!),
  };
}
