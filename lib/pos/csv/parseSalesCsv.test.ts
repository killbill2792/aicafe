import { describe, expect, it } from "vitest";
import { detectCsvColumns } from "./csvUtils";
import { parseSalesCsv } from "./parseSalesCsv";
import { parseLaborCsv } from "./parseLaborCsv";

describe("parseSalesCsv", () => {
  it("parses a Toast-style product mix export", () => {
    const csv = `Sales Date,Menu Item,Category,Qty Sold,Net Sales\n09/10/2026,Latte,Espresso,42,220.50\n09/10/2026,Drip Coffee,Coffee,30,97.50\n`;
    const { headers, rows } = detectCsvColumns(csv);
    expect(headers).toContain("Menu Item");
    const result = parseSalesCsv(rows, { date: "Sales Date", item: "Menu Item", quantity: "Qty Sold", netSales: "Net Sales", category: "Category" });
    expect(result).toEqual([
      { date: "2026-09-10", item: "Latte", quantity: 42, netSalesCents: 22_050, category: "Espresso" },
      { date: "2026-09-10", item: "Drip Coffee", quantity: 30, netSalesCents: 9_750, category: "Coffee" },
    ]);
  });
});

describe("parseLaborCsv", () => {
  it("parses a Toast-style labor time entries export with AM/PM clock times", () => {
    const csv = `Employee,Date,Clock In,Clock Out,Hourly Rate\nMaria Chen,09/10/2026,6:45 AM,2:15 PM,22.00\n`;
    const { rows } = detectCsvColumns(csv);
    const result = parseLaborCsv(rows, { employee: "Employee", date: "Date", clockIn: "Clock In", clockOut: "Clock Out", hourlyWage: "Hourly Rate" });
    expect(result).toEqual([
      { employee: "Maria Chen", clockIn: "2026-09-10T06:45:00", clockOut: "2026-09-10T14:15:00", hourlyWageCents: 2_200 },
    ]);
  });

  it("leaves clockOut null for an open shift", () => {
    const csv = `Employee,Date,Clock In,Clock Out,Hourly Rate\nDaniel,09/10/2026,7:00 AM,,19.50\n`;
    const { rows } = detectCsvColumns(csv);
    const result = parseLaborCsv(rows, { employee: "Employee", date: "Date", clockIn: "Clock In", clockOut: "Clock Out", hourlyWage: "Hourly Rate" });
    expect(result[0].clockOut).toBeNull();
  });
});
