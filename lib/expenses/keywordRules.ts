import type { ExpenseCategoryCode } from "@/lib/constants";

/** docs/06-integrations.md categorization step 5, keyword rules (checked after vendor_rules, before AI). */
const KEYWORD_RULES: { pattern: RegExp; category: ExpenseCategoryCode }[] = [
  { pattern: /pg\s*&?\s*e|pacific gas/i, category: "utilities_power" },
  { pattern: /ebmud|east bay mud|water district|water dept/i, category: "water" },
  { pattern: /comcast|at&t|att\s|xfinity|spectrum|verizon fios/i, category: "internet" },
  { pattern: /safeway|costco|restaurant depot|smart\s*&\s*final|sysco|cash\s*&\s*carry/i, category: "supplies" },
];

export function matchKeywordCategory(description: string, landlordName?: string | null): ExpenseCategoryCode | null {
  if (landlordName && landlordName.trim().length > 0) {
    const escaped = landlordName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(escaped, "i").test(description)) return "rent";
  }
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(description)) return rule.category;
  }
  return null;
}
