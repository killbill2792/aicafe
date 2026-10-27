import { describe, expect, it } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { projectedDayContributions,dayContributionCents,actualDayContributions } from "./costRecoveryShared";

describe("projectedDayContributions operating hours", () => {
  it("skips future days explicitly configured closed", () => {
    const snapshot = getFixtureSnapshot();
    const closedEveryDay = {
      sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [],
    };
    const projected = projectedDayContributions({
      ...snapshot,
      business: { ...snapshot.business, openHours: closedEveryDay },
    });
    expect(projected).toEqual([]);
  });

  it("keeps projecting when regular hours are unset", () => {
    const snapshot = getFixtureSnapshot();
    const projected = projectedDayContributions({
      ...snapshot,
      business: { ...snapshot.business, openHours: null },
    });
    expect(projected.length).toBeGreaterThan(0);
  });
});


describe("known-only labor cost recovery", () => {
  it("does not count a missing day as a covered contribution or project from it", () => {
    const snapshot=getFixtureSnapshot();
    const partial={...snapshot.monthActualDays[0],wagesCents:1200,
      staffTaxCents:144,laborWageStatus:"missing" as const};
    expect(dayContributionCents(partial)).toBeNull();
    const withPartial={...snapshot,monthActualDays:[partial]};
    expect(actualDayContributions(withPartial)).toEqual([]);
    expect(dayContributionCents({...partial,laborWageStatus:"actual"})).not.toBeNull();
  });
});
