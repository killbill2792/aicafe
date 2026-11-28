import { describe, expect, it } from "vitest";
import { readImportCsv, retainImportCsv } from "./retainImportCsv.server";

describe("import CSV source retention", () => {
  it("retains unrecognized columns, duplicate headers and short rows while screening sensitive cells", () => {
    const source = [
      'Date,Item,Unknown,Unknown,CVV,CVV,Comment',
      '2026-11-04,"Coffee, iced",0,,111,222,"Line one\nLine two"',
      '2026-11-05,Cocoa,, text ,333,444',
    ].join("\n");
    expect(retainImportCsv(source)).toEqual({
      headers: ["Date", "Item", "Unknown", "Unknown", "Comment"],
      rows: [
        ["2026-11-04", "Coffee, iced", "0", "", "Line one\nLine two"],
        ["2026-11-05", "Cocoa", "", " text "],
      ],
    });
    const imported = readImportCsv(source);
    expect([...imported.fields]).toEqual(["Date", "Item", "Unknown", "Unknown_1", "Comment"]);
    expect(imported.rows[1]).toEqual({ Date: "2026-11-05", Item: "Cocoa", Unknown: "", Unknown_1: " text " });
  });

  it("retains shift context and unknown wages without payroll identification numbers", () => {
    const source = "Employee,Wage,Shift note,Employee SSN,Bank account number\nTest Employee,, training ,000-00-0000,12345678";
    expect(retainImportCsv(source)).toEqual({
      headers: ["Employee", "Wage", "Shift note"],
      rows: [["Test Employee", "", " training "]],
    });
    expect(readImportCsv(source).rows).toEqual([{ Employee: "Test Employee", Wage: "", "Shift note": " training " }]);
  });
});
