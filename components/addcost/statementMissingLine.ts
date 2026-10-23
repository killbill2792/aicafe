import type { ReviewLine } from "@/lib/actions/expenses";
import type { ExpenseCategoryCode } from "@/lib/constants";
import { debitCentsFromInput, reconcileStatementDebit, type StatementBalance } from "@/lib/calc/statementReconciliation";

export type MissingStatementInput = { description: string; amount: string; date: string; category: ExpenseCategoryCode };

/** Missing statement transactions are debits. Use cents and reconcile the original balance check. */
export function makeMissingStatementLine(
  current: ReviewLine[],
  balance: StatementBalance,
  input: MissingStatementInput,
  reason: string,
): { line: ReviewLine; balance: StatementBalance } | null {
  const description = input.description.trim();
  const amountCents = debitCentsFromInput(input.amount);
  if (!description || amountCents === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return null;
  const [year, month, day] = input.date.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  const nextId = current.reduce((max, line) => Math.max(max, line.i), -1) + 1;
  const reconciled = reconcileStatementDebit(balance, amountCents);
  if (!reconciled) return null;
  return {
    line: { i: nextId, description, date: input.date, amountCents, category: input.category, reason, confidence: 1 },
    balance: reconciled,
  };
}
