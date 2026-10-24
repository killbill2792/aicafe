import { describe, expect, it } from "vitest";
import { summarizeVoidsRollups, type VoidsRollup } from "./voidsReview";
const day = (date: string, cents: number, status = "actual"): VoidsRollup =>
  ({ business_date: date, voids_cents: cents, sales_data_status: status });
describe("summarizeVoidsRollups", () => {
  it("sums recorded days and rounds the 3-month average only once", () => {
    expect(summarizeVoidsRollups([
      day("2026-07-01", 100), day("2026-08-01", 101),
      day("2026-09-01", 101), day("2026-10-01", 75), day("2026-10-02", 25),
    ], "2026-10")).toEqual({
      monthKey:"2026-10", thisMonthCents:100, previousThreeMonthAverageCents:101,
      days:[{date:"2026-10-01",cents:75},{date:"2026-10-02",cents:25}],
    });
  });
  it("never substitutes zero for a month with no recorded actual days", () => {
    expect(summarizeVoidsRollups([day("2026-07-01",0),day("2026-09-01",0)],"2026-10"))
      .toMatchObject({thisMonthCents:null,previousThreeMonthAverageCents:null,days:[]});
  });
  it("excludes cost-only rollups and preserves genuine recorded zeros", () => {
    expect(summarizeVoidsRollups([
      day("2026-07-01",0), day("2026-08-01",0), day("2026-09-01",0),
      day("2026-10-01",0), day("2026-10-02",900,"missing"),
    ], "2026-10")).toMatchObject({
      thisMonthCents:0,previousThreeMonthAverageCents:0,days:[{date:"2026-10-01",cents:0}],
    });
  });
  it("stays in the alert month and handles year rollover", () => {
    expect(summarizeVoidsRollups([
      day("2025-10-01",100), day("2025-11-01",200), day("2025-12-01",300),
      day("2026-01-15",1000), day("2026-02-01",5000),
    ], "2026-01")).toMatchObject({thisMonthCents:1000,previousThreeMonthAverageCents:200});
  });
});
