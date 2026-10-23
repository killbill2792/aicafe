import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPosRows } from "@/lib/pos/pagedReads";

export type StagedSalesGroup = {
  business_date: string;
  item_name: string;
  category: string | null;
  menu_item_id: string | null;
  source_row_count: number;
  conflict_reason: string | null;
};

/** The SQL finalizer may promote >1,000 groups. Read ALL staged groups before
 * reporting completion; a partial result would permanently drop line categories.
 * IDs have stable ordering independent of PostgREST's implicit default. */
export function readStagedSalesGroups(db: SupabaseClient, businessId: string, jobId: string) {
  return readAllPosRows((first,last) => db.from("csv_sales_import_groups")
    .select("business_date, item_name, category, menu_item_id, source_row_count, conflict_reason")
    .eq("job_id",jobId).eq("business_id",businessId)
    .order("id").range(first,last),"CSV staged sales groups") as Promise<StagedSalesGroup[]>;
}

/** All provider-attributed orders, not the first PostgREST page; otherwise fee
 * evidence can be incorrectly deemed complete for large CSV imports. */
export function readCsvFeeOrders(db: SupabaseClient, businessId: string, businessDate: string) {
  return readAllPosRows((first,last) => db.from("orders")
    .select("processing_fee_cents, processing_fee_status")
    .eq("business_id",businessId).eq("business_date",businessDate)
    .eq("processing_fee_provider","csv")
    .order("id").range(first,last),"CSV processing-fee orders") as Promise<Array<{
      processing_fee_cents:number|null;
      processing_fee_status:string|null;
    }>>;
}
