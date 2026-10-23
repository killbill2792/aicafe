import { describe, expect, it } from "vitest";
import { debitCentsFromInput, reconcileStatementDebit } from "./statementReconciliation";

describe("missing statement debit calculations", () => {
  it.each([
    ["1", 100], ["12.3", 1230], ["0.01", 1], ["15.00", 1500], ["1.99", 199],
  ])("parses %s into exact integer cents", (input, cents) => {
    expect(debitCentsFromInput(input)).toBe(cents);
  });
  it.each(["", "0", "-2", "12.345", "12,34", "NaN", "Infinity", "9007199254740999", "1e3"])("rejects unsafe dollar input %s", (input) => {
    expect(debitCentsFromInput(input)).toBeNull();
  });
  it("balances a missing debit against opening and closing totals", () => {
    const starting = { openingCents: 10000, closingCents: 7500, sumCents: -1000, ok: false };
    expect(reconcileStatementDebit(starting, 1500)).toEqual({
      openingCents: 10000, closingCents: 7500, sumCents: -2500, ok: true,
    });
    expect(starting.sumCents).toBe(-1000);
    expect(reconcileStatementDebit(starting, 500)?.ok).toBe(false);
    expect(reconcileStatementDebit(starting, 0)).toBeNull();
  });
}
