"use server";

import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { parseStatementCsv } from "@/lib/expenses/parseStatementCsv";
import { categorizeLines } from "@/lib/expenses/categorize";
import type { ReviewLine } from "./expenses";

export type StatementReviewResult =
  | { ok: true; lines: ReviewLine[]; balanceCheck: ReturnType<typeof parseStatementCsv>["balanceCheck"]; unrecognizedColumns: boolean }
  | { ok: false; error: string };

/** Parses an uploaded CSV, skips excluded lines, categorizes the rest (docs/03-screens.md S10). */
export async function reviewStatementCsv(csvText: string): Promise<StatementReviewResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Sign in and connect Supabase to categorize a statement." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  const businessId = await getActiveBusinessId(user.id);

  const parsed = parseStatementCsv(csvText);
  if (parsed.lines.length === 0) return { ok: false, error: "No transaction lines were found in that file." };

  // Only money-out lines get categorized (docs/06-integrations.md step 4: skip deposits/transfers
  // outright rather than sending them to the AI at all).
  const moneyOutLines = parsed.lines.filter((l) => l.amountCents < 0);
  const categorized = await categorizeLines(
    supabase,
    businessId,
    moneyOutLines.map((l) => ({ i: l.i, date: l.date, description: l.description, amount: l.amountCents / 100 })),
  );

  const byIndex = new Map(moneyOutLines.map((l) => [l.i, l]));
  const lines: ReviewLine[] = categorized
    .map((c) => {
      const original = byIndex.get(c.i);
      if (!original) return null;
      return {
        i: c.i,
        date: original.date,
        description: c.vendor || original.description,
        amountCents: Math.abs(original.amountCents),
        category: c.category,
        reason: c.reason,
        confidence: c.confidence,
      };
    })
    .filter((l): l is ReviewLine => l !== null);

  return { ok: true, lines, balanceCheck: parsed.balanceCheck, unrecognizedColumns: parsed.unrecognizedColumns };
}
