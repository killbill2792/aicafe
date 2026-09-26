import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExpenseCategoryCode } from "@/lib/constants";
import { matchKeywordCategory } from "./keywordRules";
import { normalizeVendor } from "./dedupeKey";
import { categorizeStatementLines, type StatementLineInput } from "@/lib/ai/prompts/statementCategorizing";
import { isAiConfigured } from "@/lib/ai/types";

export type CategorizedLine = {
  i: number;
  category: ExpenseCategoryCode | "exclude";
  vendor: string;
  reason: string;
  confidence: number;
  source: "vendor_rule" | "keyword" | "ai" | "uncategorized";
};

/**
 * docs/06-integrations.md categorization order: vendor_rules (learned) → keyword rules → AI for
 * the rest. Vendor rules and keyword rules are instant/free; only the lines neither can place go
 * to the AI call (and are skipped entirely — reported "uncategorized" — if no AI provider is set).
 */
export async function categorizeLines(
  supabase: SupabaseClient,
  businessId: string,
  lines: StatementLineInput[],
): Promise<CategorizedLine[]> {
  const { data: vendorRules } = await supabase.from("vendor_rules").select("normalized_vendor, category_code").eq("business_id", businessId);
  const vendorRuleMap = new Map((vendorRules ?? []).map((r) => [r.normalized_vendor, r.category_code as ExpenseCategoryCode]));

  const results: CategorizedLine[] = [];
  const needsAi: StatementLineInput[] = [];

  for (const line of lines) {
    const normalized = normalizeVendor(line.description);
    const vendorRuleHit = vendorRuleMap.get(normalized);
    if (vendorRuleHit) {
      results.push({ i: line.i, category: vendorRuleHit, vendor: line.description, reason: "Matched a vendor you've categorized before", confidence: 0.97, source: "vendor_rule" });
      continue;
    }
    const keywordHit = matchKeywordCategory(line.description);
    if (keywordHit) {
      results.push({ i: line.i, category: keywordHit, vendor: line.description, reason: `Matched vendor name ${line.description}`, confidence: 0.85, source: "keyword" });
      continue;
    }
    needsAi.push(line);
  }

  if (needsAi.length > 0 && isAiConfigured()) {
    try {
      const knownVendors = [...vendorRuleMap.keys()];
      const aiResult = await categorizeStatementLines({ knownVendors, lines: needsAi });
      for (const line of aiResult.lines) {
        const original = needsAi.find((l) => l.i === line.i);
        results.push({ i: line.i, category: line.category, vendor: line.vendor || original?.description || "", reason: line.reason, confidence: line.confidence, source: "ai" });
      }
    } catch (err) {
      console.error("[categorizeLines] AI categorization failed", err);
      for (const line of needsAi) {
        results.push({ i: line.i, category: "other", vendor: line.description, reason: "Could not categorize automatically", confidence: 0, source: "uncategorized" });
      }
    }
  } else {
    for (const line of needsAi) {
      results.push({ i: line.i, category: "other", vendor: line.description, reason: "Could not categorize automatically", confidence: 0, source: "uncategorized" });
    }
  }

  return results.sort((a, b) => a.i - b.i);
}
