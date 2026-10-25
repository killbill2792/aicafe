import {z} from "zod";
const GUID=z.uuid();
const money=z.number().int().safe();
const day=z.iso.date();
export const statusSchema=z.object({
 connection:z.enum(["not_connected","needs_attention","connected"]),
 importEnabled:z.boolean(),
 errorCategory:z.string().nullable(),lastGoodSyncAt:z.string().nullable(),stale:z.boolean(),
 backfill:z.object({daysDone:z.number().int(),daysTotal:z.number().int(),
  state:z.string().nullable(),resumeAt:z.string().nullable()}),
 failedRuns:z.number().int(),queuedRanges:z.array(z.object({from:day,to:day})),
 needsLook:z.array(z.object({date:day,restaurantGuid:GUID,oursCents:money.nullable(),toastCents:money.nullable(),
  deltaCents:money.nullable(),reason:z.string()})),
 firstImportRows:z.array(z.object({date:day,oursCents:money.nullable(),toastCents:money.nullable()})),
 recent:z.array(z.object({date:day,netSalesCents:money.nullable(),orders:z.number().int().nullable(),
  status:z.enum(["checked","checking","needs_look","missing"])})),
 analytics:z.object({connected:z.boolean(),verified:z.boolean()}),
 firstImportCheck:z.enum(["hidden","due","answered"]),
 timeZone:z.string(),startDate:day.nullable(),
 restaurantGuids:z.array(GUID),
}).strict();

/** Validate the service-role database boundary BEFORE deriving owner-facing values.
 * A malformed amount cannot silently turn a real sale into a missing/zero total.
 */
export const toastOwnerDbRows=z.object({
 mappings:z.array(z.object({restaurant_guid:GUID,verified_at:z.string().nullable(),
  toast_time_zone:z.string().nullable(),toast_start_date:day.nullable()})),
 runs:z.array(z.object({id:GUID,kind:z.string(),state:z.string(),
  days_done:z.number().int().nonnegative(),days_total:z.number().int().nonnegative(),
  resume_at:z.string().nullable(),requested_from:day.nullable(),requested_to:day.nullable()})),
 days:z.array(z.object({restaurant_guid:GUID,business_date:day,
  import_state:z.enum(["missing","imported","failed"]),recon_state:z.string(),
  net_sales_cents:money.nullable(),toast_net_sales_cents:money.nullable(),
  delta_net_cents:money.nullable(),order_count:z.number().int().nonnegative().nullable(),
  last_error_category:z.string().nullable(),coverage_complete:z.boolean()})),
 flags:z.array(z.object({restaurant_guid:GUID,business_date:day,cleared_at:z.string().nullable()}))
});
