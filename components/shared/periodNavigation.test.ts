import { describe, expect, it } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import { buildProfitAndCostsViewModel } from "@/lib/viewmodels/moneyViewModel";
import type { Period } from "@/lib/viewmodels/period";
import { needsPeriodRecovery, periodFromUrl, periodHref } from "./periodNavigation";

describe("PeriodSwitch navigation behavior", () => {
  it.each(["en", "es", "ar"])("changes only period, preserving thread, experiment, locale and query (%s)", locale => {
    const initial = `/${locale}?thread=thread%2Fone&experiment=proposal-1&view=profit&period=today`;
    const week = periodHref(`/${locale}`, initial.split("?")[1], "week");
    expect(new URL(week, "https://example.test").searchParams.get("thread")).toBe("thread/one");
    expect(new URL(week, "https://example.test").searchParams.get("experiment")).toBe("proposal-1");
    expect(new URL(week, "https://example.test").searchParams.get("view")).toBe("profit");
    expect(new URL(week, "https://example.test").searchParams.get("period")).toBe("week");
    // Replacing the current entry does not add a period-only browser Back entry.
    const month = periodHref(`/${locale}`, week.split("?")[1], "month");
    expect(periodHref(`/${locale}`, month.split("?")[1], "today"))
      .toBe(periodHref(`/${locale}`, initial.split("?")[1], "today"));
  });

  it("uses one replace when the committed server period agrees, and a single recovery for stale RSC", () => {
    expect(periodFromUrl(null)).toBe("today");
    expect(periodFromUrl("invalid")).toBe("today");\n    expect(periodFromUrl(null, "month")).toBe("month");\n    expect(periodFromUrl("bad", "month")).toBe("month");\n    expect(needsPeriodRecovery("month", periodFromUrl(null, "month"), false, false)).toBe(false);
    expect(needsPeriodRecovery("today", "month", true, false)).toBe(false);
    expect(needsPeriodRecovery("month", "month", false, false)).toBe(false);
    expect(needsPeriodRecovery("today", "month", false, false)).toBe(true);
    expect(needsPeriodRecovery("today", "month", false, true)).toBe(false);
    // Back/Forward can reveal a mismatched old payload as well; the same safeguard applies.
    expect(needsPeriodRecovery("week", "today", false, false)).toBe(true);
    expect(needsPeriodRecovery("today", "today", false, true)).toBe(false);
  });

  it("keeps Home and Money using identical actual cents for each confirmed URL period", () => {
    const snapshot = getFixtureSnapshot();
    const displayed = (["today", "week", "month"] as const).map(period => {
      const href = periodHref("/en", "thread=existing", period);
      const selected = periodFromUrl(new URL(href, "https://example.test").searchParams.get("period"));
      const home = buildHomeViewModel(snapshot, selected);
      const money = buildProfitAndCostsViewModel(snapshot, selected);
      expect(home.salesCents).toBe(money.salesCents);
      expect(home.totalCostsCents).toBe(money.totalCostsCents);
      expect(home.ownerProfitCents).toBe(money.ownerProfitCents);
      expect(home.period).toBe(period);
      return { period: selected, sales: home.salesCents, costs: home.totalCostsCents, kept: home.ownerProfitCents };
    });
    expect(displayed.map(row => row.period)).toEqual(["today", "week", "month"] satisfies Period[]);
    expect(displayed[0].sales).not.toBe(displayed[1].sales);
    expect(displayed[1].sales).not.toBe(displayed[2].sales);
  });
});
