import {z} from "zod";
const GUID=z.uuid();
const money=z.number().int().safe();
const day=z.iso.date();
export const summaryEntrySchema=z.object({restaurant_guid:GUID,business_date:day,net_sales_cents:money,
 orders_count:z.number().int().nonnegative().nullable(),comparison:z.enum(["owner_summary_match","owner_summary_mismatch"]).nullable(),
 delta_net_cents:money.nullable(),delta_orders:z.number().int().nullable(),discounts_cents:money.nullable(),refunds_cents:money.nullable(),
 voids_count:z.number().int().nullable(),source:z.enum(["typed","photo","csv"])});
export const statusSchema=z.object({
 connection:z.enum(["not_connected","needs_attention","connected"]),
 importEnabled:z.boolean(),
 errorCategory:z.string().nullable(),lastGoodSyncAt:z.string().nullable(),stale:z.boolean(),
 backfill:z.object({daysDone:z.number().int(),daysTotal:z.number().int(),
  state:z.string().nullable(),resumeAt:z.string().nullable()}),
 failedRuns:z.number().int(),queuedRanges:z.array(z.object({from:day,to:day})),
 needsLookCount:z.number().int().nonnegative(),
 checkEvidence:z.object({mode:z.enum(["official","internal"]),reason:z.string(),compared:z.number().int(),matched:z.number().int()}),
 summaryEntries:z.array(summaryEntrySchema),
 comparisonDays:z.array(z.object({date:day,restaurantGuid:GUID,oursCents:money.nullable()})),
 warnings:z.array(z.object({time_zone_mismatch:z.literal(true),toast_time_zone:z.string(),reporting_time_zone:z.string()})),
 daysWithUnreadableOrders:z.number().int(),rechecking:z.object({total:z.number().int(),remaining:z.number().int()}),
 needsLook:z.array(z.object({date:day,restaurantGuid:GUID,oursCents:money.nullable(),toastCents:money.nullable(),
  deltaCents:money.nullable(),unreadableOrders:z.number().int(),reason:z.string()})),
 firstImportRows:z.array(z.object({date:day,oursCents:money.nullable(),toastCents:money.nullable()})),
 recent:z.array(z.object({date:day,netSalesCents:money.nullable(),orders:z.number().int().nullable(),paidOtherDay:z.number().int().nonnegative(),
  status:z.enum(["checked","checked_internal","owner_match","checking","needs_look","missing"])})),
 analytics:z.object({connected:z.boolean(),verified:z.boolean(),errorCategory:z.string().nullable()}),
 firstImportCheck:z.enum(["hidden","due","answered"]),
 timeZone:z.string(),startDate:day.nullable(),
 restaurantNames:z.record(GUID,z.string()),
 restaurantGuids:z.array(GUID),
}).strict();

/** Validate the service-role database boundary BEFORE deriving owner-facing values.
 * A malformed amount cannot silently turn a real sale into a missing/zero total.
 */
export const toastOwnerDbRows=z.object({
 mappings:z.array(z.object({restaurant_guid:GUID,location_id:GUID.optional(),verified_at:z.string().nullable(),
  toast_time_zone:z.string().nullable(),toast_start_date:day.nullable(),recheck_total:z.number().int().default(0)})),
 runs:z.array(z.object({id:GUID,kind:z.string(),state:z.string(),
  days_done:z.number().int().nonnegative(),days_total:z.number().int().nonnegative(),
  resume_at:z.string().nullable(),requested_from:day.nullable(),requested_to:day.nullable()})),
 days:z.array(z.object({restaurant_guid:GUID,business_date:day,
  import_state:z.enum(["missing","imported","failed"]),recon_state:z.string(),
  net_sales_cents:money.nullable(),toast_net_sales_cents:money.nullable(),
  delta_net_cents:money.nullable(),order_count:z.number().int().nonnegative().nullable(),
  last_error_category:z.string().nullable(),coverage_complete:z.boolean(),unparsed_count:z.number().int().default(0),paid_other_day:z.number().int().default(0),rechecking_reason:z.string().nullable().default(null)})),
 flags:z.array(z.object({restaurant_guid:GUID,business_date:day,cleared_at:z.string().nullable()}))
});
