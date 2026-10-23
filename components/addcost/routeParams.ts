import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";

/** Only permit an application-local absolute path; never pass untrusted redirect URLs to next/navigation. */
export function validReturnTo(raw: string | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  const pathname = raw.split(/[?#]/, 1)[0];
  // Reject encoded separators, controls or malformed escapes that may be decoded during routing.
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(pathname) || /%(?![\da-f]{2})/i.test(raw)) return null;
  try {
    const url = new URL(raw, "https://aicafe.invalid");
    return url.origin === "https://aicafe.invalid" && url.pathname.startsWith("/") ? raw : null;
  } catch {
    return null;
  }
}

export function validCostCategory(raw: string | undefined): ExpenseCategoryCode | null {
  return raw && EXPENSE_CATEGORY_CODES.includes(raw as ExpenseCategoryCode) ? raw as ExpenseCategoryCode : null;
}

export function addCostChoiceSuffix(category?: string, returnTo?: string): string {
  const params = new URLSearchParams();
  const selected = validCostCategory(category);
  if (selected) params.set("category", selected);
  const safeReturnTo = validReturnTo(returnTo);
  if (safeReturnTo) params.set("returnTo", safeReturnTo);
  const query = params.toString();
  return query ? `?${query}` : "";
}
