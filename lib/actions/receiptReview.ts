"use server";

import { revalidatePath } from "next/cache";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { isAiConfigured } from "@/lib/ai/types";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { readReceipt, type ReceiptReadingResult } from "@/lib/ai/prompts/receiptReading";
import { computeDedupeKey } from "@/lib/expenses/dedupeKey";
import { matchKeywordCategory } from "@/lib/expenses/keywordRules";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import type { ActionResult } from "./expenses";

export type ReceiptReviewResult = { ok: true; receipt: ReceiptReadingResult; suggestedCategory: ExpenseCategoryCode } | { ok: false; error: string };

function coerceCategory(vendor: string, suggested: string): ExpenseCategoryCode {
  const fromKeyword = matchKeywordCategory(vendor);
  if (fromKeyword) return fromKeyword;
  return (EXPENSE_CATEGORY_CODES as readonly string[]).includes(suggested) ? (suggested as ExpenseCategoryCode) : "supplies";
}

/** "Photo of receipt" (docs/03-screens.md S10). `imageDataUrl` is a compressed JPEG data: URL. */
export async function reviewReceiptPhoto(imageDataUrl: string): Promise<ReceiptReviewResult> {
  if (!isAiConfigured()) return { ok: false, error: "Receipt reading needs an AI provider key — add one to .env.local (see PROGRESS.md)." };

  try {
    const receipt = await readReceipt(imageDataUrl);
    return { ok: true, receipt, suggestedCategory: coerceCategory(receipt.vendor, receipt.suggested_category) };
  } catch (err) {
    console.error("[reviewReceiptPhoto] failed", err);
    return { ok: false, error: "Couldn't read that receipt. Try again or type it in instead." };
  }
}

/** Saves a reviewed receipt as one expense + its line items, and updates the ingredient price
 * for any line the owner mapped to an ingredient (docs/06-integrations.md "Receipt photos"). */
export async function saveReceiptExpense(params: {
  receipt: ReceiptReadingResult;
  category: ExpenseCategoryCode;
  ingredientMappings: Record<number, string | undefined>; // line index -> ingredient id
}): Promise<ActionResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Sign in to save." };
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  const businessId = await getActiveBusinessId(user.id);

  const spentOn = params.receipt.date ?? new Date().toISOString().slice(0, 10);
  const dedupeKey = computeDedupeKey({ businessId, spentOn, amountCents: params.receipt.total_cents, vendor: params.receipt.vendor });

  const { data: expense, error } = await supabase
    .from("expenses")
    .insert({
      business_id: businessId,
      spent_on: spentOn,
      amount_cents: params.receipt.total_cents,
      vendor: params.receipt.vendor,
      category_code: params.category,
      source: "receipt",
      status: "actual",
      dedupe_key: dedupeKey,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return { ok: true, skipped: 1 }; // already recorded
    return { ok: false, error: error.message };
  }

  const lineRows = params.receipt.lines.map((line, i) => ({
    expense_id: expense.id,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    amount_cents: line.amount_cents,
    ingredient_id: params.ingredientMappings[i] ?? null,
  }));
  if (lineRows.length > 0) {
    await supabase.from("expense_lines").insert(lineRows);
  }

  revalidatePath("/money");
  revalidatePath("/");
  return { ok: true };
}
