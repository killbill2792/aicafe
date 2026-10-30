import {describe,it,expect} from "vitest";
import {medianCents,typicalDaySales,typicalHourlySales,changePercent,lastTimeOutlook} from "./dayOutlook";

describe("usual-day sales",()=>{
  it("takes the median of the same weekday before the cut-off, in whole cents",()=>{
    expect(medianCents([300,100,200])).toBe(200);
    expect(medianCents([100,201])).toBe(151);
    expect(medianCents([])).toBeNull();
    // Saturdays: Oct 3, 10, 17, 24 2026; a Friday and a later day are ignored.
    const days=[{date:"2026-10-03",netSalesCents:100_000},{date:"2026-10-10",netSalesCents:120_000},
      {date:"2026-10-17",netSalesCents:110_000},{date:"2026-10-24",netSalesCents:130_000},
      {date:"2026-10-23",netSalesCents:999_999},{date:"2026-10-31",netSalesCents:5}];
    expect(typicalDaySales(days,"2026-10-31","2026-10-30")).toEqual(
      {typicalCents:115_000,sampleDays:4,from:"2026-09-04",to:"2026-10-29"});
  });
  it("leaves holidays out and needs at least three days",()=>{
    const days=[{date:"2026-10-03",netSalesCents:100_000},{date:"2026-10-10",netSalesCents:500_000},
      {date:"2026-10-17",netSalesCents:110_000}];
    const r=typicalDaySales(days,"2026-10-31","2026-10-30",{exclude:new Set(["2026-10-10"])});
    expect(r.typicalCents).toBeNull();
    expect(r.sampleDays).toBe(2);
  });
  it("uses the same-weekday hourly medians from recorded hours, not invented zero hours",()=>{
    const rows=["2026-10-03","2026-10-10","2026-10-17","2026-10-24"].flatMap((date,i)=>[
      {date,hourLocal:9,netSalesCents:1000+i*100},
      {date,hourLocal:9,netSalesCents:200},
      {date,hourLocal:14,netSalesCents:3000+i*100},
    ]);
    const usual=typicalHourlySales([...rows,{date:"2026-10-23",hourLocal:14,netSalesCents:90000}],
      "2026-10-31","2026-10-30");
    expect(usual).toEqual([{hourLocal:9,typicalCents:1350,sampleDays:4},
      {hourLocal:14,typicalCents:3150,sampleDays:4}]);
    expect(typicalHourlySales(rows,"2026-10-31","2026-10-30",
      {exclude:new Set(["2026-10-10","2026-10-17"])})).toEqual([]);
  });
  it("gives the change in whole percent and refuses a zero base",()=>{
    expect(changePercent(126_000,100_000)).toBe(26);
    expect(changePercent(80_000,100_000)).toBe(-20);
    expect(changePercent(1,0)).toBeNull();
  });
  it("compares a past holiday with the usual same weekday in the 6 weeks before it",()=>{
    // Halloween 2025 was a Friday; Fridays before it sold $1,000.
    const days=[{date:"2025-10-03",netSalesCents:100_000},{date:"2025-10-10",netSalesCents:100_000},
      {date:"2025-10-17",netSalesCents:100_000},{date:"2025-10-24",netSalesCents:100_000},
      {date:"2025-10-31",netSalesCents:131_500}];
    expect(lastTimeOutlook(days,"2025-10-31")).toEqual({date:"2025-10-31",netSalesCents:131_500,
      typicalCents:100_000,changePercent:32,sampleDays:4});
    expect(lastTimeOutlook(days,"2025-10-30")).toBeNull();
    expect(lastTimeOutlook(days.slice(2),"2025-10-31")).toBeNull();
  });
});
