import { describe, expect, it } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { projectedDayContributions } from "./costRecoveryShared";

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
