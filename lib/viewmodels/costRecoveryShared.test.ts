import { describe, expect, it } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { projectedDayContributions,dayContributionCents,actualDayContributions,recoveryBuckets,recoveryBucketsFromAmounts } from "./costRecoveryShared";

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


describe("recovery order is presentation, not financial inclusion",()=>{
  it("includes stored categories outside the configured order exactly once in live and historical views",()=>{
    const snapshot=getFixtureSnapshot();
    const first={categoryCode:"rent" as const,label:"Rent",amountCents:50000,isEstimate:false,isMissing:false};
    const additional={categoryCode:"other" as const,label:"Other",amountCents:23000,isEstimate:true,isMissing:false};
    const lines=[first,additional];
    const order=["rent","rent"] as typeof snapshot.recoveryOrder;
    const current=recoveryBuckets({...snapshot,runningCostLines:lines,recoveryOrder:order});
    const historical=recoveryBucketsFromAmounts(lines.map(line=>({...line,monthKey:snapshot.monthKey})),order);
    expect(current).toEqual(historical);
    expect(current).toEqual([
      {code:"rent",amountCents:50000,isEstimate:false},
      {code:"other",amountCents:23000,isEstimate:true},
    ]);
  });
});
