"use server";

import { revalidatePath } from "next/cache";
import { formatInTimeZone } from "date-fns-tz";
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
  // The /add-cost/receipt page already gates on isAiConfigured() before this ever mounts — this
  // stays as a defensive fallback, never leaking anything about env vars or API keys to the owner.
  if (!isAiConfigured()) return { ok: false, error: "Reading receipts isn't available right now. Try again later, or type it in instead." };

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

  let spentOn = params.receipt.date;
  if (!spentOn) {
    const { data: business } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
    spentOn = formatInTimeZone(new Date(), business?.timezone ?? "America/Los_Angeles", "yyyy-MM-dd");
  }
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
    const { data: savedLines } = await supabase.from("expense_lines").insert(lineRows).select("id, quantity, unit, amount_cents, ingredient_id");
    const ingredientIds = [...new Set((savedLines ?? []).flatMap((line) => line.ingredient_id ? [line.ingredient_id] : []))];
    const { data: ingredients } = ingredientIds.length
      ? await supabase.from("ingredients").select("id, base_unit").in("id", ingredientIds).eq("business_id", businessId)
      : { data: [] };
    const unitByIngredient = new Map((ingredients ?? []).map((ingredient) => [ingredient.id, ingredient.base_unit]));
    const priceRows = (savedLines ?? []).flatMap((line) => {
      if (!line.ingredient_id || !line.quantity || Number(line.quantity) <= 0) return [];
      const normalizedUnit = String(line.unit ?? "").toLowerCase().replace(/s$/, "");
      const baseUnit = unitByIngredient.get(line.ingredient_id);
      if (!baseUnit || ![baseUnit, baseUnit === "each" ? "item" : baseUnit].includes(normalizedUnit)) return [];
      return [{
        ingredient_id: line.ingredient_id,
        effective_from: spentOn,
        cost_per_base_unit_micros: Math.round((line.amount_cents / Number(line.quantity)) * 1_000_000),
        source: "receipt",
        source_expense_line_id: line.id,
      }];
    });
    if (priceRows.length) await supabase.from("ingredient_prices").insert(priceRows);
  }

  revalidatePath("/money");
  revalidatePath("/");
  revalidatePath("/menu");
  return { ok: true };
}
