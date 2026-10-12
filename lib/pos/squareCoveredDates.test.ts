import {describe,expect,it} from "vitest";
import {squareCoveredSalesDates} from "./squareCoveredDates";
const tz="America/Los_Angeles";
const date=(iso:string)=>new Date(iso);
describe("Square-proven zero-order aggregate sales coverage",()=>{
  const now=date("2026-10-12T19:00:00Z");
  it("marks complete historical zero-order dates from an authoritative Square window",()=>{
    expect(squareCoveredSalesDates({provider:"square",timezone:tz,
      since:date("2026-10-10T07:00:00Z"),until:date("2026-10-12T07:00:00Z"),now}))
      .toEqual(["2026-10-10","2026-10-11"]);
  });
  it("covers today's sales SO FAR only after Square scanned from café-local midnight",()=>{
    expect(squareCoveredSalesDates({provider:"square",timezone:tz,
      since:date("2026-10-12T07:00:00Z"),until:date("2026-10-12T18:40:00Z"),now}))
      .toEqual(["2026-10-12"]);
    expect(squareCoveredSalesDates({provider:"square",timezone:tz,
      since:date("2026-10-12T14:00:00Z"),until:date("2026-10-12T18:40:00Z"),now}))
      .toEqual([]);
  });
  it("never promotes partial historical windows to an actual zero",()=>{
    expect(squareCoveredSalesDates({provider:"square",timezone:tz,
      since:date("2026-10-10T07:01:00Z"),until:date("2026-10-11T07:00:00Z"),now}))
      .toEqual([]);
    expect(squareCoveredSalesDates({provider:"square",timezone:tz,
      since:date("2026-10-10T07:00:00Z"),until:date("2026-10-11T06:59:59Z"),now}))
      .toEqual([]);
  });
  it("does not pretend future portions of the current day are covered",()=>{
    expect(squareCoveredSalesDates({provider:"square",timezone:tz,
      since:date("2026-10-12T07:00:00Z"),until:date("2026-10-14T07:00:00Z"),now}))
      .toEqual(["2026-10-12"]);
  });
  it("does not grant Square's explicit-zero coverage to manual, demo or CSV providers",()=>{
    for(const provider of ["csv","demo","toast","clover"] as const)
      expect(squareCoveredSalesDates({provider,timezone:tz,
        since:date("2026-10-10T07:00:00Z"),until:date("2026-10-11T07:00:00Z"),now}))
        .toEqual([]);
  });
  it("uses local midnight across daylight-saving changes",()=>{
    expect(squareCoveredSalesDates({provider:"square",timezone:tz,
      since:date("2026-11-01T07:00:00Z"),until:date("2026-11-02T08:00:00Z"),
      now:date("2026-11-03T09:00:00Z")})).toEqual(["2026-11-01"]);
  });
  it("accepts an empty or positive order batch equally when the connector proves coverage",()=>{
    // Coverage is a property of the successful query window, not order count.
    const window={provider:"square" as const,timezone:tz,
      since:date("2026-10-10T07:00:00Z"),until:date("2026-10-11T07:00:00Z"),now};
    expect(squareCoveredSalesDates(window)).toEqual(["2026-10-10"]);
  });
});
