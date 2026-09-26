import "server-only";
import { z } from "zod";
import { completeStructured } from "../complete";
import { EXPENSE_CATEGORY_CODES } from "@/lib/constants";

const Result = z.object({
  amount_cents: z.number(),
  category: z.enum(EXPENSE_CATEGORY_CODES),
  vendor: z.string().nullable(),
  date: z.string(),
  is_recurring_monthly: z.boolean(),
});
export type VoiceExpenseResult = z.infer<typeof Result>;

/** docs/06-integrations.md "Voice expense" prompt. `transcript` comes from browser speech recognition. */
export async function parseVoiceExpense(transcript: string, todayDateStr: string): Promise<VoiceExpenseResult> {
  const system = `Extract one business expense from what a café owner said. Return ONLY JSON:
{"amount_cents":int,"category":one of [${EXPENSE_CATEGORY_CODES.join(",")}],"vendor":string|null,"date":"YYYY-MM-DD" (default ${todayDateStr}),"is_recurring_monthly":boolean}`;
  return completeStructured({ task: "voice_expense", system, user: transcript, schema: Result });
}
