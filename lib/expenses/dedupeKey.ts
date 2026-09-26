import { createHash } from "node:crypto";

/** Normalizes a vendor string for matching/dedupe: lowercase, digits/punctuation collapsed. */
export function normalizeVendor(vendor: string): string {
  return vendor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** docs/04-data-model.md: dedupe_key = sha256(business_id|spent_on|amount_cents|normalized_vendor). */
export function computeDedupeKey(params: { businessId: string; spentOn: string; amountCents: number; vendor: string }): string {
  const normalized = normalizeVendor(params.vendor);
  const raw = `${params.businessId}|${params.spentOn}|${params.amountCents}|${normalized}`;
  return createHash("sha256").update(raw).digest("hex");
}
