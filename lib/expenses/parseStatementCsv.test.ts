import { describe, expect, it } from "vitest";
import { parseStatementCsv } from "./parseStatementCsv";

describe("parseStatementCsv", () => {
  it("parses a common single-amount-column US bank export", () => {
    const csv = `Date,Description,Amount\n09/02/2026,PGANDE WEB ONLINE,-412.33\n09/03/2026,SQ PAYOUT,1850.00\n`;
    const result = parseStatementCsv(csv);
    expect(result.unrecognizedColumns).toBe(false);
    expect(result.lines).toEqual([
      { i: 0, date: "2026-09-02", description: "PGANDE WEB ONLINE", amountCents: -41_233, balanceCents: null },
      { i: 1, date: "2026-09-03", description: "SQ PAYOUT", amountCents: 185_000, balanceCents: null },
    ]);
  });

  it("parses debit/credit column pairs, treating debit as money out", () => {
    const csv = `Date,Description,Debit,Credit\n09/05/2026,RESTAURANT DEPOT,214.60,\n09/06/2026,DEPOSIT,,500.00\n`;
    const result = parseStatementCsv(csv);
    expect(result.lines[0].amountCents).toBe(-21_460);
    expect(result.lines[1].amountCents).toBe(50_000);
  });

  it("checks opening + lines = closing when a balance column exists", () => {
    const csv = `Date,Description,Amount,Balance\n09/01/2026,A,-100.00,900.00\n09/02/2026,B,50.00,950.00\n`;
    const result = parseStatementCsv(csv);
    expect(result.balanceCheck?.ok).toBe(true);
  });

  it("flags unrecognized columns instead of guessing wildly", () => {
    const csv = `Foo,Bar\n1,2\n`;
    const result = parseStatementCsv(csv);
    expect(result.unrecognizedColumns).toBe(true);
  });
});

describe("source statement evidence",()=>{
 it("rejects malformed values instead of zero and impossible dates",()=>{
  const r=parseStatementCsv("Date,Description,Amount\n2026-02-30,A,10\n2026-02-28,B,garbage\n2026-02-28,C,1.234");
  expect(r.invalidRows).toEqual([2,3,4]);expect(r.lines).toEqual([]);expect(r.statementEvidence).toBeNull();
 });
 it("checks each running balance and handles descending exports",()=>{
  const header=" Date ,Description,Amount,Balance\n";
  expect(parseStatementCsv(header+"2026-02-02,B,50,950\n2026-02-01,A,-100,900").statementEvidence)
   .toMatchObject({from:"2026-02-01",to:"2026-02-02",openingCents:100000,closingCents:95000});
  expect(parseStatementCsv(header+"2026-02-01,A,-100,900\n2026-02-02,B,50,940\n2026-02-03,C,50,1000").statementEvidence).toBeNull();
  expect(parseStatementCsv(header+"2026-02-01,A,-100,900\n2026-02-02,B,50,\n2026-02-03,C,50,1000").statementEvidence).toBeNull();
 });
});
