/** Pure bank statement money calculations; all amounts are integer cents. */
export type StatementBalance = {
  openingCents: number;
  closingCents: number;
  sumCents: number;
  ok: boolean;
};

/** Parse a user-entered USD debit without passing dollars through floating-point arithmetic. */
export function debitCentsFromInput(value: string): number | null {
  const input = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(input)) return null;
  const [dollars, cents = ""] = input.split(".");
  const whole = Number(dollars);
  const fraction = Number(cents.padEnd(2, "0"));
  if (!Number.isSafeInteger(whole) || whole > Math.floor((Number.MAX_SAFE_INTEGER - fraction) / 100)) return null;
  const amountCents = whole * 100 + fraction;
  return Number.isSafeInteger(amountCents) && amountCents > 0 ? amountCents : null;
}

/** A newly supplied missing expense lowers the statement's net transaction sum. */
export function reconcileStatementDebit(balance: StatementBalance, debitCents: number): StatementBalance | null {
  if (!Number.isSafeInteger(debitCents) || debitCents <= 0) return null;
  const sumCents = balance.sumCents - debitCents;
  if (!Number.isSafeInteger(sumCents)) return null;
  return {
    ...balance,
    sumCents,
    ok: balance.openingCents + sumCents === balance.closingCents,
  };
}
