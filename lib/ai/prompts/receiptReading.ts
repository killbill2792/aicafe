import "server-only";
import { z } from "zod";
import { completeStructured } from "../complete";

const LIKELY_INGREDIENTS = ["milk", "oat_milk", "espresso_beans", "cups", "lids", "syrup", "pastry", "cleaning", "other"] as const;

const ReceiptLine = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  amount_cents: z.number(),
  likely_ingredient: z.enum(LIKELY_INGREDIENTS),
});
const Result = z.object({
  vendor: z.string(),
  date: z.string().nullable(),
  total_cents: z.number(),
  tax_cents: z.number(),
  lines: z.array(ReceiptLine),
  suggested_category: z.string(),
});
export type ReceiptReadingResult = z.infer<typeof Result>;

/** docs/06-integrations.md "Receipt reading" prompt. `imageDataUrl` is a "data:image/jpeg;base64,..." URL. */
export async function readReceipt(imageDataUrl: string): Promise<ReceiptReadingResult> {
  const system = `Read this store receipt. Return ONLY JSON:
{"vendor":string,"date":"YYYY-MM-DD","total_cents":int,"tax_cents":int,"lines":[{"description":string,"quantity":number|null,"unit":string|null,"amount_cents":int,"likely_ingredient":one of [${LIKELY_INGREDIENTS.join(",")}]}],"suggested_category":string}
If a value is unreadable, use null. Line amounts must add up to total minus tax; if they don't, still return what you read.`;

  return completeStructured({
    task: "receipt_reading",
    system,
    user: "Read the attached receipt image.",
    imageDataUrl,
    schema: Result,
  });
}
