import { describe, expect, it } from "vitest";
import { detectCsvColumns } from "./csvUtils";
import { parseSalesCsv } from "./parseSalesCsv";
import { parseLaborCsv } from "./parseLaborCsv";
import { parseProcessingFeesCsv, processingFeeTotalsByDate } from "./parseProcessingFeesCsv";

describe("parseSalesCsv", () => {
  it("parses a Toast-style product mix export", () => {
    const csv = `Sales Date,Menu Item,Category,Qty Sold,Net Sales\n09/10/2026,Latte,Espresso,42,220.50\n09/10/2026,Drip Coffee,Coffee,30,97.50\n`;
    const { headers, rows } = detectCsvColumns(csv);
    expect(headers).toContain("Menu Item");
    const result = parseSalesCsv(rows, { date: "Sales Date", item: "Menu Item", quantity: "Qty Sold", netSales: "Net Sales", category: "Category" });
    expect(result).toEqual({
      valid: [
        { date: "2026-09-10", item: "Latte", quantity: 42, netSalesCents: 22_050, category: "Espresso", processingFeeCents: 0, processingFeeStatus: "missing" },
        { date: "2026-09-10", item: "Drip Coffee", quantity: 30, netSalesCents: 9_750, category: "Coffee", processingFeeCents: 0, processingFeeStatus: "missing" },
      ],
      rejected: [],
    });
  });

  it("marks a mapped attributable fee actual while leaving a blank mapped fee missing", () => {
    const rows = [
      { Date: "10/02/2026", Item: "Latte", Qty: "1", Sales: "$5.50", Fee: "$0.19" },
      { Date: "10/02/2026", Item: "Tea", Qty: "1", Sales: "$4.00", Fee: "" },
    ];
    expect(parseSalesCsv(rows, { date: "Date", item: "Item", quantity: "Qty", netSales: "Sales", processingFee: "Fee" }).valid).toEqual([
      { date: "2026-10-02", item: "Latte", quantity: 1, netSalesCents: 550, category: null, processingFeeCents: 19, processingFeeStatus: "actual" },
      { date: "2026-10-02", item: "Tea", quantity: 1, netSalesCents: 400, category: null, processingFeeCents: 0, processingFeeStatus: "missing" },
    ]);
  });

  it("rejects rows missing an item or date instead of silently dropping them unaccounted for", () => {
    const rows = [
      { Date: "10/02/2026", Item: "", Qty: "1", Sales: "$5.50" },
      { Date: "", Item: "Tea", Qty: "1", Sales: "$4.00" },
      { Date: "10/02/2026", Item: "Latte", Qty: "1", Sales: "$5.50" },
    ];
    const result = parseSalesCsv(rows, { date: "Date", item: "Item", quantity: "Qty", netSales: "Sales" });
    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toEqual(
      expect.arrayContaining([
        { reason: "missing_item", count: 1 },
        { reason: "missing_date", count: 1 },
      ]),
    );
  });

  it("rejects an unparseable date instead of coercing it to today or a garbage string", () => {
    const rows = [{ Date: "not-a-date", Item: "Latte", Qty: "1", Sales: "$5.50" }];
    const result = parseSalesCsv(rows, { date: "Date", item: "Item", quantity: "Qty", netSales: "Sales" });
    expect(result.valid).toEqual([]);
    expect(result.rejected).toEqual([{ reason: "invalid_date", count: 1 }]);
  });

  it("rejects an unparseable quantity or net-sales value instead of silently zeroing it", () => {
    const rows = [
      { Date: "10/02/2026", Item: "Latte", Qty: "abc", Sales: "$5.50" },
      { Date: "10/02/2026", Item: "Tea", Qty: "1", Sales: "n/a" },
    ];
    const result = parseSalesCsv(rows, { date: "Date", item: "Item", quantity: "Qty", netSales: "Sales" });
    expect(result.valid).toEqual([]);
    expect(result.rejected).toEqual(
      expect.arrayContaining([
        { reason: "invalid_quantity", count: 1 },
        { reason: "invalid_net_sales", count: 1 },
      ]),
    );
  });
});

describe("parseProcessingFeesCsv", () => {
  it("parses generic date and actual fee columns, normalizing signed costs", () => {
    const result = parseProcessingFeesCsv([
      { "Sales date": "10/01/2026", "Processing fee": "$82.00" },
      { "Sales date": "2026-10-02", "Processing fee": "-75.41" },
    ], { date: "Sales date", processingFee: "Processing fee" });
    expect(result).toEqual({ valid: [
      { date: "2026-10-01", actualProcessingFeeCents: 8_200 },
      { date: "2026-10-02", actualProcessingFeeCents: 7_541 },
    ], invalidRows: 0 });
  });

  it("reports blank or invalid rows for owner attention", () => {
    expect(parseProcessingFeesCsv([
      { Date: "10/01/2026", Fee: "" },
      { Date: "not-a-date", Fee: "10.00" },
    ], { date: "Date", processingFee: "Fee" })).toEqual({ valid: [], invalidRows: 2 });
  });

  it("combines overlapping rows into one selected daily amount", () => {
    expect([...processingFeeTotalsByDate([
      { date: "2026-10-01", actualProcessingFeeCents: 4_000 },
      { date: "2026-10-01", actualProcessingFeeCents: 4_200 },
      { date: "2026-10-02", actualProcessingFeeCents: 7_541 },
    ])]).toEqual([["2026-10-01", 8_200], ["2026-10-02", 7_541]]);
  });
});

describe("parseLaborCsv", () => {
  it("parses a Toast-style labor time entries export with AM/PM clock times", () => {
    const csv = `Employee,Date,Clock In,Clock Out,Hourly Rate\nMaria Chen,09/10/2026,6:45 AM,2:15 PM,22.00\n`;
    const { rows } = detectCsvColumns(csv);
    const result = parseLaborCsv(rows, { employee: "Employee", date: "Date", clockIn: "Clock In", clockOut: "Clock Out", hourlyWage: "Hourly Rate" });
    expect(result).toEqual({
      valid: [{ employee: "Maria Chen", clockIn: "2026-09-10T06:45:00", clockOut: "2026-09-10T14:15:00", hourlyWageCents: 2_200 }],
      rejected: [],
    });
  });

  it("leaves clockOut null for an open shift", () => {
    const csv = `Employee,Date,Clock In,Clock Out,Hourly Rate\nDaniel,09/10/2026,7:00 AM,,19.50\n`;
    const { rows } = detectCsvColumns(csv);
    const result = parseLaborCsv(rows, { employee: "Employee", date: "Date", clockIn: "Clock In", clockOut: "Clock Out", hourlyWage: "Hourly Rate" });
    expect(result.valid[0].clockOut).toBeNull();
  });

  it("imports a shift with an unknown wage instead of blocking on a missing wage column", () => {
    const csv = `Employee,Date,Clock In,Clock Out\nDaniel,09/10/2026,7:00 AM,3:00 PM\n`;
    const { rows } = detectCsvColumns(csv);
    const result = parseLaborCsv(rows, { employee: "Employee", date: "Date", clockIn: "Clock In", clockOut: "Clock Out" });
    expect(result.valid).toEqual([
      { employee: "Daniel", clockIn: "2026-09-10T07:00:00", clockOut: "2026-09-10T15:00:00", hourlyWageCents: null },
    ]);
  });

  it("treats a blank or garbage wage cell as unknown, never a fabricated $0", () => {
    const rows = [
      { Employee: "Daniel", Date: "09/10/2026", "Clock In": "7:00 AM", "Clock Out": "3:00 PM", Wage: "" },
      { Employee: "Maria", Date: "09/10/2026", "Clock In": "8:00 AM", "Clock Out": "4:00 PM", Wage: "n/a" },
    ];
    const result = parseLaborCsv(rows, { employee: "Employee", date: "Date", clockIn: "Clock In", clockOut: "Clock Out", hourlyWage: "Wage" });
    expect(result.valid.map((r) => r.hourlyWageCents)).toEqual([null, null]);
  });

  it("rejects rows missing an employee name or clock-in instead of silently dropping them unaccounted for", () => {
    const rows = [
      { Employee: "", Date: "09/10/2026", "Clock In": "7:00 AM", "Clock Out": "" },
      { Employee: "Daniel", Date: "09/10/2026", "Clock In": "", "Clock Out": "" },
    ];
    const result = parseLaborCsv(rows, { employee: "Employee", date: "Date", clockIn: "Clock In", clockOut: "Clock Out" });
    expect(result.valid).toEqual([]);
    expect(result.rejected).toEqual(
      expect.arrayContaining([
        { reason: "missing_employee", count: 1 },
        { reason: "missing_clock_in", count: 1 },
      ]),
    );
  });
});
