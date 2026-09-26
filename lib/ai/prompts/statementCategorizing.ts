import "server-only";
import { z } from "zod";
import { completeStructured } from "../complete";
import { EXPENSE_CATEGORY_CODES } from "@/lib/constants";

const LineResult = z.object({
  i: z.number(),
  category: z.enum([...EXPENSE_CATEGORY_CODES, "exclude"]),
  vendor: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});
const Result = z.object({ lines: z.array(LineResult) });
export type StatementCategorizingResult = z.infer<typeof Result>;

export type StatementLineInput = { i: number; date: string; description: string; amount: number };

/** docs/06-integrations.md "Statement line categorizing" prompt, verbatim intent. */
export async function categorizeStatementLines(params: {
  landlordName?: string;
  knownVendors?: string[];
  lines: StatementLineInput[];
}): Promise<StatementCategorizingResult> {
  const system = `You categorize business bank transactions for an independent café in the US.
Return ONLY JSON: {"lines":[{"i":number,"category":one of [${EXPENSE_CATEGORY_CODES.join(",")},exclude],"vendor":string,"reason":string (max 12 words, plain English),"confidence":0..1}]}
Use "exclude" for transfers between the owner's accounts, owner withdrawals, credit card payments, tax payments, and deposits.`;
  const user = `Café context: landlord name "${params.landlordName ?? "unknown"}", known vendors: ${
    (params.knownVendors ?? []).join(", ") || "none"
  }. Lines: ${JSON.stringify(params.lines)}`;

  return completeStructured({ task: "statement_categorizing", system, user, schema: Result });
}
