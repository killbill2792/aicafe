"use server";

import { revalidatePath } from "next/cache";
import { formatInTimeZone } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { isAiConfigured } from "@/lib/ai/types";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import {requireOwnerAccessScope} from "@/lib/access/access.server";
import {getTranslations} from "next-intl/server";
import { readReceipt, type ReceiptReadingResult } from "@/lib/ai/prompts/receiptReading";
import { computeDedupeKey } from "@/lib/expenses/dedupeKey";
import { matchKeywordCategory } from "@/lib/expenses/keywordRules";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import type { ActionResult } from "./expenses";
import {recordPurchases,type PurchaseLineInput} from "@/lib/inventory/recordPurchases.server";

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
    const {access}=await requireOwnerAccessScope();
    if(!access.active){
      const t=await getTranslations("FreeAccess");
      return {ok:false,error:t("expired")};
    }
    const receipt = await readReceipt(imageDataUrl);
    return { ok: true, receipt, suggestedCategory: coerceCategory(receipt.vendor, receipt.suggested_category) };
  } catch {
    console.error("receipt_review_failed");
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
  const {data:member,error:memberError}=await supabase.from("memberships")
    .select("role,businesses(is_demo)").eq("business_id",businessId).eq("user_id",user.id).maybeSingle();
  const b=member?.businesses as unknown as {is_demo:boolean}|{is_demo:boolean}[]|null;
  const isDemo=Array.isArray(b)?b[0]?.is_demo:b?.is_demo;
  if(memberError||member?.role!=="owner"||isDemo!==false)
    return {ok:false,error:"Only a café owner can save a receipt."};

  let spentOn = params.receipt.date;
  if (!spentOn) {
    const { data: business } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
    spentOn = formatInTimeZone(new Date(), business?.timezone ?? "America/Los_Angeles", "yyyy-MM-dd");
  }
  const dedupeKey = computeDedupeKey({ businessId, spentOn, amountCents: params.receipt.total_cents, vendor: params.receipt.vendor });

  const {data:created,error}=await supabase.from("expenses").insert({
    business_id:businessId,spent_on:spentOn,amount_cents:params.receipt.total_cents,
    vendor:params.receipt.vendor,category_code:params.category,
    source:"receipt",status:"actual",dedupe_key:dedupeKey
  }).select("id").single();
  if(error&&error.code!=="23505")return {ok:false,error:"Couldn't save the receipt."};
  let expense=created;
  if(!expense){
    const existing=await supabase.from("expenses").select("id")
      .eq("business_id",businessId).eq("dedupe_key",dedupeKey).eq("source","receipt").maybeSingle();
    if(existing.error||!existing.data)return {ok:false,error:"Receipt duplicate needs review."};
    expense=existing.data;
  }
  const rows=params.receipt.lines.map((line,index)=>({
    expense_id:expense.id,receipt_line_index:index,description:line.description,
    quantity:line.quantity,unit:line.unit,amount_cents:line.amount_cents,
    ingredient_id:params.ingredientMappings[index]??null
  }));
  if(rows.length){
    const {error:linesError}=await supabase.from("expense_lines").upsert(rows,{
      onConflict:"expense_id,receipt_line_index"
    });
    if(linesError)return {ok:false,error:"Receipt saved but lines could not be saved. Try again."};
    const {data:savedLines,error:fetchError}=await supabase.from("expense_lines")
      .select("id,receipt_line_index,quantity,unit,amount_cents,ingredient_id")
      .eq("expense_id",expense.id).not("receipt_line_index","is",null);
    if(fetchError||!savedLines)return {ok:false,error:"Receipt saved but stock lines could not be read. Try again."};
    const purchases:PurchaseLineInput[]=savedLines.flatMap(line=>{
      if(!line.ingredient_id||!line.quantity||Number(line.quantity)<=0)return [];
      return [{lineId:line.id,ingredientId:line.ingredient_id,date:spentOn,
        quantity:Number(line.quantity),unit:String(line.unit??""),
        costCents:line.amount_cents,expenseLineId:line.id}];
    });
    if(purchases.length){
      const results=await recordPurchases(purchases,"receipt_page",expense.id);
      if(results.some(result=>!result.ok))
        return {ok:false,error:"Expense saved, but some stock lines need review. Correct their units and try again."};
    }
  }

  revalidatePath("/money");
  revalidatePath("/");
  revalidatePath("/menu");
  return { ok: true };
}
