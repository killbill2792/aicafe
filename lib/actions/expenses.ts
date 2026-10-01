"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { computeDedupeKey, normalizeVendor } from "@/lib/expenses/dedupeKey";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * "Today" in the business's own timezone, not server UTC — a bill saved or removed in the
 * evening (business-local time) in a US timezone is already "tomorrow" in UTC, which pushed
 * active_from/active_to a day late and made a just-added bill miss today's totals (found while
 * verifying the repeatable "Other" bills feature against live data).
 */
async function todayDateStrForBusiness(supabase: SupabaseClient, businessId: string): Promise<string> {
  const { data } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  return formatInTimeZone(new Date(), data?.timezone ?? "America/Los_Angeles", "yyyy-MM-dd");
}

export type ReviewLine = {
  i: number;
  date: string; // YYYY-MM-DD
  description: string;
  amountCents: number; // positive = money out
  category: ExpenseCategoryCode | "exclude";
  reason: string;
  confidence: number;
};

export type ActionResult = { ok: true; skipped?: number } | { ok: false; error: string };

async function currentBusinessId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return getActiveBusinessId(user.id);
}

const ManualExpenseSchema = z.object({
  amountCents: z.number().int().positive(),
  category: z.enum(EXPENSE_CATEGORY_CODES),
  vendor: z.string().optional(),
  spentOn: z.string(), // YYYY-MM-DD
  // A free-text label the owner types for their own naming (mainly under "other") — the fixed
  // category codes still drive cost recovery / health checks / rent-share-per-drink; this is
  // display-only, so an owner's own vocabulary shows through without touching the money math.
  customLabel: z.string().max(60).optional(),
});

/** "Type it" (docs/03-screens.md S10): amount → category → date, saved as an actual expense. */
export async function addManualExpense(input: z.infer<typeof ManualExpenseSchema>): Promise<ActionResult> {
  const parsed = ManualExpenseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a valid amount and category." };

  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in to add a cost." };

  const supabase = await createServerSupabaseClient();
  const vendor = parsed.data.vendor?.trim() || parsed.data.category;
  const dedupeKey = computeDedupeKey({ businessId, spentOn: parsed.data.spentOn, amountCents: parsed.data.amountCents, vendor });

  const { error } = await supabase.from("expenses").insert({
    business_id: businessId,
    spent_on: parsed.data.spentOn,
    amount_cents: parsed.data.amountCents,
    vendor,
    category_code: parsed.data.category,
    source: "manual",
    status: "actual",
    dedupe_key: dedupeKey,
    custom_label: parsed.data.customLabel?.trim() || null,
  });
  if (error && error.code !== "23505") return { ok: false, error: error.message }; // 23505 = already recorded (dedupe)

  revalidatePath("/money");
  revalidatePath("/");
  return { ok: true };
}

const RecurringCostSchema = z.object({
  id: z.string().optional(),
  category: z.enum(EXPENSE_CATEGORY_CODES),
  label: z.string().min(1),
  amountCents: z.number().int().positive(),
  frequency: z.enum(["monthly", "weekly", "quarterly", "yearly"]),
  dueDay: z.number().int().min(1).max(31).optional(),
  isEstimate: z.boolean().optional(),
});

/** Monthly bills (docs/03-screens.md S11): add or edit a recurring cost. */
export async function saveRecurringCost(input: z.infer<typeof RecurringCostSchema>): Promise<ActionResult> {
  const parsed = RecurringCostSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the amount and category." };

  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in to add a bill." };

  const supabase = await createServerSupabaseClient();
  const row = {
    business_id: businessId,
    category_code: parsed.data.category,
    label: parsed.data.label,
    amount_cents: parsed.data.amountCents,
    frequency: parsed.data.frequency,
    due_day: parsed.data.dueDay ?? null,
    is_estimate: parsed.data.isEstimate ?? false,
  };

  const { error } = parsed.data.id
    ? await supabase.from("recurring_costs").update(row).eq("id", parsed.data.id).eq("business_id", businessId)
    : await supabase.from("recurring_costs").insert({ ...row, active_from: await todayDateStrForBusiness(supabase, businessId) });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/more/bills");
  revalidatePath("/money");
  revalidatePath("/");
  return { ok: true };
}

export async function deleteRecurringCost(id: string): Promise<ActionResult> {
  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("recurring_costs")
    .update({ active_to: await todayDateStrForBusiness(supabase, businessId) })
    .eq("id", id)
    .eq("business_id", businessId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/more/bills");
  revalidatePath("/money");
  return { ok: true };
}

/**
 * Saves reviewed statement/receipt lines as expenses. Duplicate dedupe_key rows are silently
 * skipped (docs/06-integrations.md: "a receipt photo and its bank line are the same purchase").
 * Any correction the owner made (line.correctedCategory differs from what was suggested) is
 * remembered as a vendor_rule for next time.
 */
export async function saveCategorizedLines(
  source: "statement" | "receipt",
  lines: (ReviewLine & { correctedCategory?: ExpenseCategoryCode })[],
): Promise<ActionResult> {
  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in to save." };
  const supabase = await createServerSupabaseClient();

  const toInsert = lines
    .filter((l) => (l.correctedCategory ?? l.category) !== "exclude")
    .map((l) => {
      const category = (l.correctedCategory ?? l.category) as ExpenseCategoryCode;
      return {
        business_id: businessId,
        spent_on: l.date,
        amount_cents: l.amountCents,
        vendor: l.description,
        category_code: category,
        source,
        status: "actual" as const,
        confidence: l.confidence,
        reason: l.reason,
        dedupe_key: computeDedupeKey({ businessId, spentOn: l.date, amountCents: l.amountCents, vendor: l.description }),
      };
    });

  if (toInsert.length === 0) return { ok: true };

  // Duplicate dedupe_key rows (e.g. a receipt already recorded the same purchase a bank line
  // would otherwise add again) are skipped one at a time rather than failing the whole batch.
  let skipped = 0;
  for (const row of toInsert) {
    const { error } = await supabase.from("expenses").insert(row);
    if (error) {
      if (error.code === "23505") {
        skipped += 1;
        continue;
      }
      return { ok: false, error: error.message };
    }
  }

  // Remember corrections as vendor_rules for next time (docs/06-integrations.md step 7).
  const corrections = lines.filter((l) => l.correctedCategory && l.correctedCategory !== l.category);
  if (corrections.length > 0) {
    await supabase.from("vendor_rules").upsert(
      corrections.map((l) => ({
        business_id: businessId,
        normalized_vendor: normalizeVendor(l.description),
        category_code: l.correctedCategory,
      })),
      { onConflict: "business_id,normalized_vendor" },
    );
  }

  revalidatePath("/money");
  revalidatePath("/");
  return { ok: true, skipped };
}
