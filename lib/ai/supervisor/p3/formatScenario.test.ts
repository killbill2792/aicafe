import {describe,expect,it} from "vitest";
import {formatScenarioValue,formatScenarioAssumption} from "./formatScenario";

describe("localized, source-safe scenario presentation",()=>{
  it("does not expose internal cents-per-item or basis-point units",()=>{
    const es=formatScenarioValue(525,"USD_cents_per_item","es");
    expect(es).toContain("5,25");
    expect(es).toContain("por unidad");
    expect(es).not.toContain("USD_cents");
    expect(formatScenarioValue(1000,"ratio_bps","es")).toContain("10%");
  });
  it("renders Arabic and Spanish owner hypotheticals in local units",()=>{
    expect(formatScenarioAssumption("٢٥ item","ar")).toContain("وحدات");
    expect(formatScenarioAssumption("12,5 USD_cents_per_item","es"))
      .toContain("por unidad");
    expect(formatScenarioAssumption("10 ratio_bps","es")).toContain("10%");
    expect(formatScenarioAssumption("25 item","en")).toContain("items");
  });
  it("localizes time, volume and comparisons",()=>{
    expect(formatScenarioValue(0.75,"hour","es")).toContain("horas");
    expect(formatScenarioValue(12,"US_fl_oz","en")).toContain("US fl oz");
    expect(formatScenarioValue(0,"comparison","ar")).toBe("متساويان");
  });
});
