import { describe, expect, it } from "vitest";
import { isUnusualVoids, summarizeVoidsRollups, type VoidsRollup } from "./voidsReview";

const day = (
  date: string, cents: number, voidsCoverage: "complete" | "unknown" = "unknown",
  sales = "actual",
): VoidsRollup => ({
  business_date: date, voids_cents: cents, voidsCoverage, sales_data_status: sales,
});

function completeMonth(month: string, perDay = 0): VoidsRollup[] {
  const [year, num] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, num, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => day(
    `${month}-${String(i + 1).padStart(2, "0")}`, perDay, "complete",
  ));
}

describe("void amount coverage is independent of sales data coverage", () => {
  it("does not treat CSV actual-sales rollups with discarded voids as $0", () => {
    const csv = [day("2026-07-01", 0), day("2026-08-01", 0),
      day("2026-09-01", 0), day("2026-10-01", 0)];
    expect(isUnusualVoids(summarizeVoidsRollups(csv, "2026-10", "2026-10-01"))).toBe(false);
    expect(summarizeVoidsRollups(csv, "2026-10", "2026-10-01")).toEqual({
      monthKey: "2026-10", thisMonthCents: null,
      previousThreeMonthAverageCents: null, days: [],
    });
  });

  it("preserves observed positive days but does not claim a full-month total or three-month average", () => {
    const rows = [day("2026-07-02", 101), day("2026-08-02", 101),
      day("2026-09-02", 101), day("2026-10-01", 12988),
      day("2026-10-02", 0), day("2026-10-03", 999, "unknown", "missing")];
    expect(summarizeVoidsRollups(rows, "2026-10", "2026-10-03")).toEqual({
      monthKey: "2026-10", thisMonthCents: null,
      previousThreeMonthAverageCents: null,
      days: [{ date: "2026-10-01", cents: 12988 }],
    });
  });

  it("accepts true zero only with separate complete void coverage on every day", () => {
    const rows = ["2026-07", "2026-08", "2026-09", "2026-10"]
      .flatMap(month => completeMonth(month));
    expect(summarizeVoidsRollups(rows, "2026-10", "2026-10-02"))
      .toMatchObject({
        thisMonthCents: 0, previousThreeMonthAverageCents: 0,
        days: [{ date: "2026-10-01", cents: 0 }, { date: "2026-10-02", cents: 0 }],
      });
  });

  it("averages exactly three independently verified months and sums integer cents", () => {
    const rows = [
      ...completeMonth("2026-07"), ...completeMonth("2026-08"),
      ...completeMonth("2026-09"), ...completeMonth("2026-10"),
    ];
    const amounts = [100, 101, 101];
    for (const [i, month] of ["2026-07", "2026-08", "2026-09"].entries()) {
      rows.find(row => row.business_date === month + "-01")!.voids_cents = amounts[i];
    }
    rows.find(row => row.business_date === "2026-10-01")!.voids_cents = 75;
    rows.find(row => row.business_date === "2026-10-02")!.voids_cents = 25;
    expect(summarizeVoidsRollups(rows, "2026-10", "2026-10-02"))
      .toMatchObject({ thisMonthCents: 100, previousThreeMonthAverageCents: 101 });
    rows.find(row => row.business_date === "2026-10-01")!.voids_cents = 15000;
    expect(isUnusualVoids(summarizeVoidsRollups(rows, "2026-10", "2026-10-02"))).toBe(true);
  });

  it("refuses partial historical months and an uncovered current day", () => {
    const rows = ["2026-07", "2026-08", "2026-09", "2026-10"]
      .flatMap(month => completeMonth(month));
    rows.splice(rows.findIndex(row => row.business_date === "2026-08-13"), 1);
    rows.find(row => row.business_date === "2026-10-02")!.voidsCoverage = "unknown";
    expect(summarizeVoidsRollups(rows, "2026-10", "2026-10-02"))
      .toMatchObject({ thisMonthCents: null, previousThreeMonthAverageCents: null });
  });

  it("handles December-to-January rollover without accepting other months", () => {
    const rows = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]
      .flatMap(month => completeMonth(month));
    rows.find(row => row.business_date === "2025-10-01")!.voids_cents = 100;
    rows.find(row => row.business_date === "2025-11-01")!.voids_cents = 200;
    rows.find(row => row.business_date === "2025-12-01")!.voids_cents = 300;
    rows.find(row => row.business_date === "2026-01-01")!.voids_cents = 1000;
    expect(summarizeVoidsRollups(rows, "2026-01", "2026-01-15"))
      .toMatchObject({ thisMonthCents: 1000, previousThreeMonthAverageCents: 200 });
  });

  it("cannot certify overflow, negative values or non-integer money as complete", () => {
    const rows = ["2026-07", "2026-08", "2026-09", "2026-10"]
      .flatMap(month => completeMonth(month));
    rows.find(row => row.business_date === "2026-07-01")!.voids_cents = -1;
    rows.find(row => row.business_date === "2026-10-01")!.voids_cents = 0.5;
    expect(summarizeVoidsRollups(rows, "2026-10", "2026-10-01"))
      .toMatchObject({ thisMonthCents: null, previousThreeMonthAverageCents: null });
  });
});
