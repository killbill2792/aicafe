import { describe, expect, it } from "vitest";
import { readSalesCsvForImport, retainSalesCsv } from "./retainSalesCsv.server";

describe("sales CSV source retention", () => {
  it("retains unrecognized columns, duplicate headers and short rows while screening sensitive cells", () => {
    const source = [
      'Date,Item,Unknown,Unknown,CVV,CVV,Comment',
      '2026-11-04,"Coffee, iced",0,,111,222,"Line one\nLine two"',
      '2026-11-05,Cocoa,, text ,333,444',
    ].join("\n");
    expect(retainSalesCsv(source)).toEqual({
      headers: ["Date", "Item", "Unknown", "Unknown", "Comment"],
      rows: [
        ["2026-11-04", "Coffee, iced", "0", "", "Line one\nLine two"],
        ["2026-11-05", "Cocoa", "", " text "],
      ],
    });
    const imported = readSalesCsvForImport(source);
    expect([...imported.fields]).toEqual(["Date", "Item", "Unknown", "Unknown_1", "Comment"]);
    expect(imported.rows[1]).toEqual({ Date: "2026-11-05", Item: "Cocoa", Unknown: "", Unknown_1: " text " });
  });
});
