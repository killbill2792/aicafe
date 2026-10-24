import {z} from "zod";
const GUID=z.uuid();
const money=z.number().int().safe();
const day=z.iso.date();
export const statusSchema=z.object({
 connection:z.enum(["not_connected","needs_attention","connected"]),
 errorCategory:z.string().nullable(),lastGoodSyncAt:z.string().nullable(),stale:z.boolean(),
 backfill:z.object({daysDone:z.number().int(),daysTotal:z.number().int(),
  state:z.string().nullable(),resumeAt:z.string().nullable()}),
 failedRuns:z.number().int(),
 needsLook:z.array(z.object({date:day,restaurantGuid:GUID,oursCents:money.nullable(),toastCents:money.nullable(),
  deltaCents:money.nullable(),reason:z.string()})),
 recent:z.array(z.object({date:day,netSalesCents:money.nullable(),orders:z.number().int().nullable(),
  status:z.enum(["checked","checking","needs_look","missing"])})),
 analytics:z.object({connected:z.boolean(),verified:z.boolean()}),
 firstImportCheck:z.enum(["hidden","due","answered"]),
 timeZone:z.string(),startDate:day.nullable(),
 restaurantGuids:z.array(GUID),
}).strict();
