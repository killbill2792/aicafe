import "server-only";
import {unverifiedToastSalesDates} from "@/lib/pos/toast/reportingCoverage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fromZonedTime } from "date-fns-tz";
import { rowToDailyFacts } from "@/lib/data/runningCostCatalog";
import type { DailyFacts } from "@/lib/calc";
import type { CafeStatePeriod, KnownSlice } from "@/lib/operating/types";
import { rangeExpectedDays } from "./conversations/dateRange";

export type MenuCatalogProduct = { id: string; name: string; category: "drink" | "food"; active: boolean; priceCents: number };
export type StaffAttendance = { timecardCount: number; onClockCount: number };
const quality = (missingInputs: string[] = []) => ({
  level: (missingInputs.length ? "low" : "high") as "low" | "high",
  missingInputs, estimatedInputs: [] as string[], staleInputs: [] as string[],
});
function missing<T>(reason: string): KnownSlice<T> {
  return { available:false, value:null, quality:quality([reason]) };
}
/** Only bounded invoker-RLS reads, with business identity bound by the session. */
export function supervisorHistoricalReaders(client: SupabaseClient, businessId: string) {
  function assertScope(requested: string) {
    if (!businessId || requested !== businessId) throw new Error("Café access scope mismatch");
  }
  return {
    async salesTrend(id: string, period: CafeStatePeriod): Promise<KnownSlice<DailyFacts[]>> {
      assertScope(id);
      const { data, error } = await client.from("daily_rollups")
        .select("business_date, net_sales_cents, orders_count, drinks_count, ingredients_cents, staff_wages_cents, staff_tax_cents, staff_tax_status, staff_tax_source, sales_data_status, card_fees_cents, card_fees_status, voids_cents")
        .eq("business_id",id).gte("business_date",period.from).lte("business_date",period.to)
        .order("business_date",{ascending:true}).limit(370);
      if (error) throw error;
      // Only explicit canonical actual coverage proves aggregate sales, including
      // genuine $0 days. Null/legacy/staff-only statuses must remain unknown.
      // Do not call Toast-source days confirmed on the strength of canonical
      // rollups alone. This guard is only enabled in an explicitly authorized pilot.
      // A missing/failed coverage check fails CLOSED; unrelated Square-only
      // operation retains the exact original path when the pilot flag is unset.
      let blocked=new Set<string>();
      if(process.env.TOAST_PILOT_IMPORT_ENABLED==="true"){
        try {blocked=await unverifiedToastSalesDates(client,id,period.from,period.to);}
        catch {return missing("toastSalesVerificationUnavailable");}
      }
      const days=(data??[]).filter(row=>row.sales_data_status==="actual"&&
        !blocked.has(row.business_date)).map(rowToDailyFacts);
      if (!days.length) return missing(blocked.size?"toastSalesAwaitingIndependentReview":"noCoveredSalesRows");
      const expected = rangeExpectedDays(period), covered = new Set(days.map(d=>d.date)).size;
      return { available:true, value:days, quality:quality([
        ...(covered < expected ? ["salesCoverage:"+covered+"/"+expected] : []),
        ...(blocked.size ? ["toastSalesAwaitingIndependentReview"] : [])
      ]) };
    },
    async menuCatalog(id: string): Promise<KnownSlice<MenuCatalogProduct[]>> {
      assertScope(id);
      const { data, error } = await client.from("menu_items")
        .select("id, name, category, is_active, price_cents").eq("business_id",id).limit(501);
      if (error) throw error;
      return { available:true, value:(data ?? []).slice(0,500).map(row=>({
        id:String(row.id),name:String(row.name).slice(0,120),
        category:row.category === "food" ? "food" as const : "drink" as const,
        active:row.is_active !== false,priceCents:Number(row.price_cents ?? 0),
      })),quality:quality((data ?? []).length > 500 ? ["menuCatalogTruncated"] : []) };
    },
    async staffAttendance(id: string, period: CafeStatePeriod, timezone: string): Promise<KnownSlice<StaffAttendance>> {
      assertScope(id);
      const start = fromZonedTime(period.from+"T00:00:00",timezone).toISOString();
      const end = fromZonedTime(period.to+"T23:59:59.999",timezone).toISOString();
      const { data, error } = await client.from("timecards").select("clock_in,clock_out")
        .eq("business_id",id).gte("clock_in",start).lte("clock_in",end).limit(501);
      if (error) throw error;
      if (!data?.length) return missing("noRecordedTimecards");
      return { available:true, value:{
        timecardCount:Math.min(data.length,500),
        onClockCount:data.slice(0,500).filter(row=>!row.clock_out).length,
      },quality:quality(data.length > 500 ? ["timecardResultTruncated"] : []) };
    },
  };
}
