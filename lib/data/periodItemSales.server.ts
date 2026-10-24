import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PeriodItemSalesEvidence} from "./types";
import type {CafeStatePeriod} from "@/lib/operating/types";
import {resolveItemSalesCoverage} from "@/lib/ai/supervisorFacts.server";

/** One bounded, authenticated, invoker-RLS source of item participation.
 * Existing RPC computes exact-period quantities in SQL; no unbounded line scans
 * and no assumed coverage for CSV, demo or aggregate-only sources.
 */
export async function readPeriodItemSales(
  supabase:SupabaseClient,businessId:string,period:CafeStatePeriod,
):Promise<PeriodItemSalesEvidence>{
  const unknown=():PeriodItemSalesEvidence=>({period,covered:false,soldItems:[]});
  const {data:connections,error:connectionError}=await supabase.from("pos_connections")
    .select("provider,last_synced_at,backfill_completed_at")
    .eq("business_id",businessId).eq("status","active");
  if(connectionError)return unknown();
  if(!resolveItemSalesCoverage(connections??[],period).covered)return unknown();
  const {data,error}=await supabase.rpc("menu_item_quantities_sold",{
    p_business_id:businessId,p_from:period.from,p_to:period.to,
  });
  if(error||!Array.isArray(data)||data.length>=1000)return unknown();
  // The canonical quantities RPC excludes NULL menu_item_id rows. An unlinked
  // non-voided order line would silently disappear even when other item rows
  // were present. Use a bounded EXISTS-style exact count through the parent
  // order's business/date scope. If this cannot be proven, remain partial.
  const {count,error:unlinkedError}=await supabase.from("order_lines")
    .select("id, orders!inner(business_id,business_date)",{count:"exact",head:true})
    .is("menu_item_id",null).eq("voided",false)
    .eq("orders.business_id",businessId)
    .eq("orders.toast_excluded",false).is("orders.superseded_by",null)
    .gte("orders.business_date",period.from)
    .lte("orders.business_date",period.to);
  if(unlinkedError||count===null||count===undefined||count>0)return unknown();
  // A capped RPC response cannot prove that every distinct sold item is present.
  const items:Array<{id:string;units:number}>=[];
  for(const row of data??[]){
    const id=row?.menu_item_id,units=Number(row?.total_quantity);
    // Malformed/unlinked item evidence is not proof that all sold costs are known.
    if(typeof id!=="string"||!id||!Number.isFinite(units)||units<0)return unknown();
    if(units>0)items.push({id,units});
  }
  return {period,covered:true,soldItems:items};
}
