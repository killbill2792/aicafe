import {z} from "zod";
export const quoteInput=z.strictObject({
 requestId:z.uuid(),
 supplierName:z.string().trim().min(2).max(120),
 itemName:z.string().trim().min(2).max(120),
 priceCents:z.number().int().min(1).max(100000000),
 packageCount:z.number().int().min(1).max(100000),
 packageUnit:z.enum(["each","oz","lb","kg","gal","liter","case"]),
 sourceKind:z.enum(["supplier_email","supplier_quote","public_listing"]),
 sourceUrl:z.url().max(500).refine(x=>new URL(x).protocol==="https:").nullable(),
 quotedOn:z.iso.date(),
 /** Optional for legacy clients. Missing currency is UNKNOWN, not the café currency. */
 currencyCode:z.string().regex(/^[A-Z]{3}$/u).nullable().optional(),
 ingredientId:z.uuid().nullable().optional(),
 validUntil:z.iso.date().nullable().optional(),
 availableStatus:z.enum(["unknown","confirmed","unavailable"]).optional(),
 availableCheckedAt:z.iso.date().nullable().optional(),
 deliveryOn:z.iso.date().nullable().optional(),
});
export const researchQuery=z.string().trim().min(3).max(120);
export type Quote=z.infer<typeof quoteInput>;
export type SavedQuote=Omit<Quote,"requestId"> & {id:string;createdAt:string;evidenceStatus:"owner_reported"};
export type PublicSource={title:string;url:string;snippet:string;queriedAt:string;
 evidenceStatus:"unverified_search_snippet"};
