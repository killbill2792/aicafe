import type { ReviewLine } from "@/lib/actions/expenses";
import type { ExpenseCategoryCode } from "@/lib/constants";

export type StatementBalance = { openingCents: number; closingCents: number; sumCents: number; ok: boolean };
export type MissingStatementInput = { description: string; amount: string; date: string; category: ExpenseCategoryCode };

/** Missing statement transactions are debits. Use cents and reconcile the original balance check. */
export function makeMissingStatementLine(
  current: ReviewLine[],
  balance: StatementBalance,
  input: MissingStatementInput,
  reason: string,
): { line: ReviewLine; balance: StatementBalance } | null {
  const description = input.description.trim();
  if (!description || !/^\d+(?:\.\d{1,2})?$/.test(input.amount)) return null;
  const amountCents = Math.round(Number(input.amount) * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return null;
  const [year, month, day] = input.date.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  const nextId = Math.max(-1, ...current.map((line) => line.i)) + 1;
  const sumCents = balance.sumCents - amountCents;
  return {
    line: { i: nextId, description, date: input.date, amountCents, category: input.category, reason, confidence: 1 },
    balance: { ...balance, sumCents, ok: balance.openingCents + sumCents === balance.closingCents },
  };
}
