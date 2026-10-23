import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import ar from "../../messages/ar.json";
import { openHoursToWeeklyInput, weeklyInputToOpenHours } from "@/lib/business/openHours";
import { copyMondayToWeekdays, countryOptions, currencyForCountry, currencyOptions, matchingTimezoneOptions, moveTimezoneActiveIndex, shouldFocusHours, timezoneOptionScrollTop, timezoneOptions, usStateOptions, US_STATES, validateProfile } from "./cafeProfileOptions";

describe("café profile redesign", () => {
  it("filters the displayed timezone text, including the browser's automatic default", () => {
    const options = timezoneOptions("en", "America/Los_Angeles");
    const browserLabel = options.find((option) => option.value === "America/Los_Angeles")?.label ?? "";
    const matches = matchingTimezoneOptions(options, browserLabel, "en");
    expect(matches.some((option) => option.value === "America/Los_Angeles")).toBe(true);
    expect(matches.some((option) => option.value === "America/New_York")).toBe(false);
    expect(matchingTimezoneOptions(options, "", "en")).toHaveLength(40);
  });

  it("keeps combobox keyboard focus within available options () => {
    expect(moveTimezoneActiveIndex(-1, 1, 40)).toBe(0);
    expect(moveTimezoneActiveIndex(-1, -1, 40)).toBe(39);
    expect(moveTimezoneActiveIndex(0, -1, 40)).toBe(0);
    expect(moveTimezoneActiveIndex(39, 1, 40)).toBe(39);
    expect(moveTimezoneActiveIndex(3, 1, 40)).toBe(4);
    expect(moveTimezoneActiveIndex(3, -1, 40)).toBe(2);
    expect(moveTimezoneActiveIndex(-1, 1, 0)).toBe(-1);
    expect(moveTimezoneActiveIndex(-1, -1, 0)).toBe(-1);
  });

  it("scrolls overflowing timezone options into view without moving an already visible option", () => {
    expect(timezoneOptionScrollTop(0, 256, 300, 48)).toBe(92);
    expect(timezoneOptionScrollTop(200, 256, 96, 48)).toBe(96);
    expect(timezoneOptionScrollTop(96, 256, 144, 48)).toBe(96);
    expect(timezoneOptionScrollTop(0, 256, 0, 48)).toBe(0);
  });

  it("timezone picker displays plain labels but retains IANA storage values () => {
    const options = timezoneOptions("en", "America/Los_Angeles");
    const losAngeles = options.find((item) => item.value === "America/Los_Angeles");
    expect(losAngeles).toBeDefined();
    expect(losAngeles?.label).toContain("Los Angeles");
    expect(losAngeles?.label).toMatch(/Pacific/);
    expect(options.some((item) => item.value === "UTC")).toBe(true);
  });

  it("country and currency pickers retain uppercase ISO identifiers", () => {
    expect(countryOptions("es").find((item) => item.value === "ES")?.label).toBeTruthy();
    expect(currencyOptions("ar").find((item) => item.value === "USD")?.value).toBe("USD");
    expect(currencyForCountry("US")).toBe("USD");
    expect(currencyForCountry("ES")).toBe("EUR");
    expect(currencyForCountry("GB")).toBe("GBP");
    expect(currencyForCountry("SA")).toBe("SAR");
  });

  it("localizes U.S. state names without changing stored values", () => {
    const spanish = usStateOptions(es.CafeProfile.usStates).find((item) => item.value === "NM");
    const arabic = usStateOptions(ar.CafeProfile.usStates).find((item) => item.value === "CA");
    expect(spanish?.label).toBe("Nuevo México");
    expect(arabic?.label).toBe("كاليفورنيا");
    expect(arabic?.legacyName).toBe("California");
    expect(usStateOptions(ar.CafeProfile.usStates)).toHaveLength(56);
    for (const locale of [en, es, ar]) {
      expect(Object.keys(locale.CafeProfile.usStates)).toHaveLength(US_STATES.length);
      for (const [code] of US_STATES) {
        expect(locale.CafeProfile.usStates[code]).toBeTruthy();
      }
    }
  });

  it("copies Monday state and hours to Tuesday through Friday, not weekends", () => {
    const hours = openHoursToWeeklyInput({
      mon: [["08:30", "16:15"]],
      tue: [],
      sat: [["09:00", "12:00"]],
    });
    const next = copyMondayToWeekdays(hours);
    for (const day of ["tue", "wed", "thu", "fri"] as const) {
      expect(next[day]).toEqual({ mode: "open", open: "08:30", close: "16:15" });
    }
    expect(next.sun).toEqual(hours.sun);
    expect(next.sat).toEqual(hours.sat);
    expect(next.mon).toEqual(hours.mon);
    expect(weeklyInputToOpenHours(next)?.tue).toEqual([["08:30", "16:15"]]);
  });

  it("copies Monday's Closed and Not set modes without turning them into Open", () => {
    const hours = openHoursToWeeklyInput(null);
    hours.mon = { mode: "closed" };
    expect(copyMondayToWeekdays(hours).fri).toEqual({ mode: "closed" });
    hours.mon = { mode: "unset" };
    expect(copyMondayToWeekdays(hours).tue).toEqual({ mode: "unset" });
  });

  it("recognizes only the hours deep link", () => {
    expect(shouldFocusHours("hours")).toBe(true);
    expect(shouldFocusHours("staff")).toBe(false);
    expect(shouldFocusHours(undefined)).toBe(false);
    expect(shouldFocusHours(["hours"])).toBe(false);
  });

  it("validates submitted identifiers and times without changing stored formats", () => {
    const hours = openHoursToWeeklyInput({ mon: [["08:00", "17:00"]] });
    const messages = { name: "name", timezone: "timezone", currency: "currency", country: "country", openedOn: "date", hours: "hours" };
    expect(validateProfile({
      name: "Cafe", timezone: "America/Los_Angeles", currency: "USD",
      countryCode: "US", openedOn: "2024-01-02", hours,
    }, messages)).toEqual({});
    hours.mon = { mode: "open", open: "09:00", close: "09:00" };
    expect(validateProfile({
      name: "Cafe", timezone: "America/Los_Angeles", currency: "USD", countryCode: "US",
      openedOn: "2025-02-30", hours: openHoursToWeeklyInput(null),
    }, messages)).toEqual({ openedOn: "date" });
    expect(validateProfile({
      name: "", timezone: "invalid-timezone", currency: "US", countryCode: "USA",
      openedOn: "invalid", hours,
    }, messages)).toEqual({
      name: "name", timezone: "timezone", currency: "currency", countryCode: "country", openedOn: "date", "hours-mon": "hours",
    });
  });
});
